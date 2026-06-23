import { Client } from "@notionhq/client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import pdf from "pdf-parse";

// Notion
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// Gemini :contentReference[oaicite:1]{index=1}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// =====================
// DOWNLOAD + EXTRACT PDF
// =====================
async function extractPDF(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const data = await pdf(Buffer.from(buffer));
  return data.text;
}

// =====================
// GET PDF FROM NOTION PAGE
// =====================
async function getPDFTextFromNotion() {
  const blocks = await notion.blocks.children.list({
    block_id: process.env.NOTION_PAGE_ID,
  });

  let text = "";

  for (const block of blocks.results) {

    // PDF FILE BLOCK
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

  return text;
}

// =====================
// MAIN API
// =====================
export default async function handler(req, res) {
  try {
    const { message } = req.body;

    // STEP 1: ONLY PDF TEXT
    const context = await getPDFTextFromNotion();

    const prompt = `
You are HR assistant.

Use ONLY this PDF content:

${context}

Question:
${message}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    res.status(200).json({
      answer: response.text(),
    });

  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
}
