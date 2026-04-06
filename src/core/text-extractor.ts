import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import { extname, join } from "path";
import { logger } from "@/core/logger";

const execFileAsync = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_BIN!;
const WHISPER_BIN = process.env.WHISPER_BIN!;
const TESSERACT_BIN = process.env.TESSERACT_BIN || "tesseract";
const PDFTOTEXT_BIN = process.env.PDFTOTEXT_BIN || "pdftotext";

/** Text-readable file extensions */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl",
  ".xml", ".html", ".htm", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".log", ".env",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go",
  ".java", ".c", ".cpp", ".h", ".hpp", ".rs", ".swift",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".proto",
  ".css", ".scss", ".less", ".sass",
  ".r", ".R", ".m", ".pl", ".lua", ".dart",
]);

/** Image extensions for OCR */
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp",
]);

export interface ExtractionResult {
  text: string | null;
  method: "text-read" | "pdf" | "ocr" | "whisper" | "unsupported";
  error?: string;
}

/** Extract text from a file based on its type */
export async function extractText(filePath: string): Promise<ExtractionResult> {
  const ext = extname(filePath).toLowerCase();

  // Text files — direct read
  if (TEXT_EXTENSIONS.has(ext)) {
    return extractFromTextFile(filePath);
  }

  // PDF — pdftotext
  if (ext === ".pdf") {
    return extractFromPdf(filePath);
  }

  // Images — OCR
  if (IMAGE_EXTENSIONS.has(ext)) {
    return extractFromImage(filePath);
  }

  // Audio/Video — whisper
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".wma", ".mp4", ".webm", ".mkv", ".avi", ".mov"].includes(ext)) {
    return extractFromAudio(filePath);
  }

  // Try reading as text (might work for unknown text formats)
  try {
    const buf = await readFile(filePath);
    if (buf.length === 0) {
      return { text: null, method: "unsupported", error: "Empty file" };
    }
    // Check first 8KB for binary content (non-printable chars)
    const sample = buf.subarray(0, 8192);
    let nonPrintable = 0;
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i];
      if (b < 32 && b !== 9 && b !== 10 && b !== 13) nonPrintable++;
    }
    if (nonPrintable / sample.length > 0.1) {
      return { text: null, method: "unsupported", error: "Binary file, cannot extract text" };
    }
    return { text: buf.toString("utf-8"), method: "text-read" };
  } catch (e) {
    logger.warn({ err: e, filePath, ext }, "Text extraction failed");
    return { text: null, method: "unsupported", error: `Unsupported file type: ${ext}` };
  }
}

/** Read a text file directly */
function extractFromTextFile(filePath: string): ExtractionResult {
  try {
    const content = readFileSync(filePath, "utf-8");
    return { text: content, method: "text-read" };
  } catch (e) {
    return { text: null, method: "text-read", error: `Failed to read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Extract text from PDF using pdftotext */
async function extractFromPdf(filePath: string): Promise<ExtractionResult> {
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT_BIN, ["-layout", filePath, "-"], { timeout: 30000 });
    const text = stdout.trim();
    if (!text) {
      // PDF might be image-based, try OCR approach
      return { text: null, method: "pdf", error: "PDF contains no extractable text (may be image-based)" };
    }
    return { text, method: "pdf" };
  } catch (e) {
    logger.debug({ err: e, filePath }, "pdftotext failed");
    return { text: null, method: "pdf", error: `pdftotext failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Extract text from image using tesseract OCR */
async function extractFromImage(filePath: string): Promise<ExtractionResult> {
  try {
    const { stdout } = await execFileAsync(TESSERACT_BIN, [
      filePath, "stdout",
      "-l", "kor+eng",
      "--psm", "3",
    ], { timeout: 60000 });
    const text = stdout.trim();
    if (!text) {
      return { text: null, method: "ocr", error: "OCR produced no text" };
    }
    return { text, method: "ocr" };
  } catch (e) {
    logger.debug({ err: e, filePath }, "tesseract OCR failed");
    return { text: null, method: "ocr", error: `OCR failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Extract text from audio/video using whisper */
async function extractFromAudio(filePath: string): Promise<ExtractionResult> {
  const tmpDir = filePath + "_whisper_tmp";
  try {
    mkdirSync(tmpDir, { recursive: true });

    // Convert to mp3 first
    const mp3Path = join(tmpDir, "audio.mp3");
    await execFileAsync(FFMPEG_BIN, [
      "-y", "-i", filePath,
      "-acodec", "libmp3lame", "-q:a", "4", "-ac", "1", "-ar", "16000",
      mp3Path,
    ], { timeout: 60000 });

    // Run whisper
    await execFileAsync(WHISPER_BIN, [
      mp3Path,
      "--model", "base",
      "--language", "ko",
      "--output_dir", tmpDir,
      "--output_format", "txt",
    ], { timeout: 120000 });

    const txtPath = join(tmpDir, "audio.txt");
    const text = existsSync(txtPath) ? readFileSync(txtPath, "utf-8").trim() : null;

    if (!text) {
      return { text: null, method: "whisper", error: "Whisper produced no text" };
    }
    return { text, method: "whisper" };
  } catch (e) {
    logger.debug({ err: e, filePath }, "whisper extraction failed");
    return { text: null, method: "whisper", error: `Whisper failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { logger.warn({ err: e, tmpDir }, "Failed to cleanup whisper tmpDir"); }
  }
}
