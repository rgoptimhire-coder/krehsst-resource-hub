import { Client } from "@notionhq/client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import pdf from "pdf-parse";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// =====================
// GLOBAL CACHE (IMPORTANT FIX)
// =====================
let cachedText = "";
let cacheTime = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

// =====================
// PDF EXTRACT SAFE
// =====================
async function extractPDF(url) {
  try {
    const res = await fetch(url);

    if (!res.ok) return "";

    const buffer = await res.arrayBuffer();
    const data = await pdf(Buffer.from(buffer));

    return data.text || "";

  } catch (err) {
    console.log("PDF error:", err.message);
    return "";
  }
}

// =====================
// GET NOTION PDF TEXT (SAFE)
// =====================
async function loadPDFOnce() {
  const now = Date.now();

  if (cachedText && now - cacheTime < CACHE_DURATION) {
    return cachedText;
  }

  const blocks = await notion.blocks.children.list({
    block_id: process.env.NOTION_PAGE_ID,
  });

  let text = "";

  for (const block of blocks.results) {
    if (block.type === "file") {
      const url = block.file?.file?.url || block.file?.url;

      if (url) {
        const pdfText = await extractPDF(url);
        text += pdfText + "\n";
      }
    }
  }

  cachedText = text;
  cacheTime = now;

  return text;
}

// =====================
// MAIN API
// =====================
export default async function handler(req, res) {
  try {
    const { message } = req.body;

    const context = await loadPDFOnce();

    console.log("PDF LENGTH:", context.length);

    if (!context || context.length < 50) {
      return res.status(200).json({
        answer: "No readable PDF data found. Please check file upload in Notion."
      });
    }

    const prompt = `
You are HR assistant.

RULES:
- ONLY use PDF content below
- If not found, say "Not in company policy"

PDF:
${context}

Question:
${message}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return res.status(200).json({
      answer: response.text(),
    });

  } catch (error) {
    return res.status(200).json({
      answer: "Error: " + error.message,
    });
  }
}
