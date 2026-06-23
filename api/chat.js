import { Client } from "@notionhq/client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import pdf from "pdf-parse";

// =====================
// NOTION
// =====================
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// =====================
// GEMINI :contentReference[oaicite:1]{index=1}
// =====================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// =====================
// SIMPLE IN-MEMORY CACHE (FAST FIX)
// =====================
let cachedPDFText = null;
let lastFetchTime = 0;
const CACHE_TIME = 1000 * 60 * 30; // 30 minutes

// =====================
// PDF EXTRACT
// =====================
async function extractPDF(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const data = await pdf(Buffer.from(buffer));
  return data.text;
}

// =====================
// GET PDF ONCE (FAST CACHE)
// =====================
async function getPDFTextFromNotion() {
  const now = Date.now();

  // If cached and fresh → return instantly
  if (cachedPDFText && now - lastFetchTime < CACHE_TIME) {
    return cachedPDFText;
  }

  const blocks = await notion.blocks.children.list({
    block_id: process.env.NOTION_PAGE_ID,
  });

  let text = "";

  for (const block of blocks.results) {
    if (block.type === "file") {
      const fileUrl = block.file?.file?.url || block.file?.url;

      if (fileUrl) {
        try {
          const pdfText = await extractPDF(fileUrl);
          text += pdfText + "\n";
        } catch (err) {
          console.log("PDF error:", err.message);
        }
      }
    }
  }

  // Save cache
  cachedPDFText = text;
  lastFetchTime = now;

  return text;
}

// =====================
// MAIN API (FAST + SAFE)
// =====================
export default async function handler(req, res) {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "No message provided" });
    }

    // ⚡ FAST PDF LOAD (cached)
    const context = await getPDFTextFromNotion();

    const prompt = `
You are HR assistant.

Use ONLY this PDF knowledge:

${context}

Question:
${message}
`;

    // ⚡ Gemini call
    const result = await model.generateContent(prompt);
    const response = await result.response;

    return res.status(200).json({
      answer: response.text(),
    });

  } catch (error) {
    return res.status(200).json({
      answer: "Sorry, I couldn't process your request right now."
    });
  }
}
