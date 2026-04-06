import TelegramBot from "node-telegram-bot-api";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { bot, TOKEN } from "@/telegram/client";
import { handleDownloadError } from "@/telegram/helpers";
import { previewVideo, buildVideoPrompt } from "@/telegram/video";
import { USERS_LOG_DIR } from "@/core/config";
import { logger } from "@/core/logger";

// --- Voice transcription (Whisper) ---
const execFileAsync = promisify(execFile);
const WHISPER_BIN = process.env.WHISPER_BIN!;
const FFMPEG_BIN = process.env.FFMPEG_BIN!;

/** Download a telegram file and save to user's uploads dir, return local path */
export async function downloadTelegramFile(fileId: string, fileName: string, userId: number): Promise<string> {
  const uploadDir = join(USERS_LOG_DIR, String(userId), "uploads");
  mkdirSync(uploadDir, { recursive: true });
  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const localPath = join(uploadDir, safeName);

  const filePath = await bot.getFileLink(fileId);
  const res = await fetch(filePath, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(localPath, buffer);

  return localPath;
}

/** Transcribe a voice/audio file using whisper. Returns transcribed text or null on failure. */
export async function transcribeVoice(audioPath: string): Promise<string | null> {
  try {
    const outputDir = audioPath.replace(/\.[^.]+$/, "_whisper");
    mkdirSync(outputDir, { recursive: true });

    // Convert ogg to mp3 first (whisper works better with mp3)
    const mp3Path = join(outputDir, "audio.mp3");
    await execFileAsync(FFMPEG_BIN, [
      "-y", "-i", audioPath,
      "-acodec", "libmp3lame", "-q:a", "4", "-ac", "1", "-ar", "16000",
      mp3Path,
    ], { timeout: 30000 });

    // Run whisper with base model (fast, ~3min for 12min audio)
    await execFileAsync(WHISPER_BIN, [
      mp3Path,
      "--model", "base",
      "--language", "ko",
      "--output_dir", outputDir,
      "--output_format", "txt",
    ], { timeout: 120000 });

    const txtPath = join(outputDir, "audio.txt");
    const result = existsSync(txtPath) ? readFileSync(txtPath, "utf-8").trim() : null;
    try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
    return result;
  } catch (e) {
    logger.error({ err: e }, "Whisper transcription failed");
    return null;
  }
}

/** Build prompt from message attachments (documents, photos, videos, voice, audio) */
export async function buildPromptFromMessage(
  msg: TelegramBot.Message,
  chatId: number,
  userId: number,
): Promise<string> {
  let text = msg.text || msg.caption || "";
  const attachedFiles: string[] = [];
  const videoPrompts: string[] = [];

  // Handle document (PDF, etc.)
  if (msg.document) {
    try {
      const fileName = msg.document.file_name || "file";
      const localPath = await downloadTelegramFile(msg.document.file_id, fileName, userId);
      attachedFiles.push(localPath);
    } catch (e) {
      await handleDownloadError(chatId, e, "파일", msg.message_thread_id);
    }
  }

  // Handle photo (get highest resolution)
  if (msg.photo && msg.photo.length > 0) {
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const localPath = await downloadTelegramFile(photo.file_id, "photo.jpg", userId);
      attachedFiles.push(localPath);
    } catch (e) {
      await handleDownloadError(chatId, e, "사진", msg.message_thread_id);
    }
  }

  // Handle video / video_note / animation (GIF)
  if (msg.video || msg.video_note || msg.animation) {
    try {
      const media = msg.video || msg.video_note || msg.animation!;
      type WithFileName = { file_name?: string };
      const fileName = (msg.video as WithFileName)?.file_name || (msg.animation as WithFileName)?.file_name || "video.mp4";
      const localPath = await downloadTelegramFile(media.file_id, fileName, userId);
      const uploadDir = join(USERS_LOG_DIR, String(userId), "uploads");
      const preview = await previewVideo(localPath, uploadDir);
      videoPrompts.push(buildVideoPrompt(localPath, preview));
    } catch (e) {
      await handleDownloadError(chatId, e, "동영상", msg.message_thread_id);
    }
  }

  // Handle voice message (recorded in Telegram) — transcribe as command/text
  if (msg.voice) {
    try {
      const localPath = await downloadTelegramFile(msg.voice.file_id, "voice.ogg", userId);
      const duration = msg.voice.duration || 0;
      if (duration > 300) {
        attachedFiles.push(localPath);
      } else {
        const transcript = await transcribeVoice(localPath);
        if (transcript) {
          const voiceText = `[음성 메시지 텍스트]\n${transcript}`;
          text = text ? `${voiceText}\n\n${text}` : voiceText;
          try { unlinkSync(localPath); } catch {}
        } else {
          attachedFiles.push(localPath);
        }
      }
    } catch (e) {
      await handleDownloadError(chatId, e, "음성", msg.message_thread_id);
    }
  }

  // Handle audio file (mp3, wav, etc.)
  if (msg.audio) {
    try {
      const fileName = (msg.audio as { file_name?: string } & typeof msg.audio).file_name || "audio.mp3";
      const localPath = await downloadTelegramFile(msg.audio.file_id, fileName, userId);
      attachedFiles.push(localPath);
    } catch (e) {
      await handleDownloadError(chatId, e, "오디오", msg.message_thread_id);
    }
  }

  // Build final prompt with file references + video analysis
  if (attachedFiles.length > 0 || videoPrompts.length > 0) {
    const parts: string[] = [];
    if (videoPrompts.length > 0) parts.push(...videoPrompts);
    if (attachedFiles.length > 0) {
      const fileList = attachedFiles.map((f) => `[Attached file: ${f.split("/").pop()} at path: ${f}]`).join("\n");
      parts.push(fileList);
    }
    const allAttachments = parts.join("\n\n");
    text = text ? `${allAttachments}\n\n${text}` : `${allAttachments}\n\n이 파일을 확인해주세요.`;
  }

  return text;
}

/**
 * Build a single combined prompt from multiple messages in a media group.
 */
export async function buildPromptFromMediaGroup(
  messages: TelegramBot.Message[],
  chatId: number,
  userId: number,
): Promise<string> {
  type WithMediaGroupId = TelegramBot.Message & { media_group_id?: string };
  logger.info(
    { mediaGroupId: (messages[0] as WithMediaGroupId).media_group_id, messageCount: messages.length, userId },
    "Building combined prompt from media group",
  );

  // Process every message in parallel — each returns its own prompt fragment
  const prompts = await Promise.all(
    messages.map((msg) => buildPromptFromMessage(msg, chatId, userId)),
  );

  // Collect the caption/text (usually only the first message has one)
  const caption = messages.map((m) => m.caption || m.text || "").find((t) => t.trim() !== "") || "";

  // Collect all "[Attached file: …]" lines from every prompt
  const fileLines = prompts
    .flatMap((p) => p.split("\n").filter((line) => line.startsWith("[Attached file:")))
  ;

  // Collect all video analysis blocks (everything that is NOT a file line or the caption)
  const videoBlocks = prompts
    .flatMap((p) =>
      p.split("\n\n").filter(
        (block) => !block.startsWith("[Attached file:") && block.trim() !== caption.trim() && block.trim() !== "" && block.trim() !== "이 파일을 확인해주세요.",
      ),
    )
  ;

  // Assemble final prompt
  const parts: string[] = [];
  if (videoBlocks.length > 0) parts.push(...videoBlocks);
  if (fileLines.length > 0) parts.push(fileLines.join("\n"));

  const allAttachments = parts.join("\n\n");
  const finalPrompt = caption
    ? `${allAttachments}\n\n${caption}`
    : `${allAttachments}\n\n이 파일들을 확인해주세요.`;

  logger.info(
    { mediaGroupId: (messages[0] as WithMediaGroupId).media_group_id, totalFiles: fileLines.length, userId },
    "Media group prompt built successfully",
  );

  return finalPrompt;
}
