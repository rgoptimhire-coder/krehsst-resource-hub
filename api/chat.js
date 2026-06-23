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
// GEMINI :contentReference[oaicite:0]{index=0}
// =====================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// =====================
// PDF EXTRACTOR
// =====================
async function extractPDF(url) {
  try {
    const res = await fetch(url);

    const buffer = await res.arrayBuffer();
    const data = await pdf(Buffer.from(buffer));

    return data.text || "";

  } catch (err) {
    console.log("PDF error:", err.message);
    return "";
  }
}

// =====================
// GET ALL PDF TEXT FROM NOTION
// =====================
async function getPDFText() {
  const blocks = await notion.blocks.children.list({
    block_id: process.env.NOTION_PAGE_ID,
  });

  let text = "";

  for (const block of blocks.results) {

    if (block.type === "file") {
      const url =
        block.file?.file?.url ||
        block.file?.url;

      if (url) {
        const pdfText = await extractPDF(url);
        text += pdfText + "\n";
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

    // STEP 1: GET PDF CONTENT
    const context = await getPDFText();

    // DEBUG (important)
    console.log("PDF CONTEXT LENGTH:", context.length);

    if (!context || context.length < 50) {
      return res.status(200).json({
        answer: "No PDF content found in Notion. Please check file upload."
      });
    }

    // STEP 2: STRICT PROMPT
    const prompt = `
You are an HR assistant.

RULES:
- Use ONLY the PDF content below
- If answer is not in PDF, say "Not found in policy"
- Do NOT use external knowledge

PDF CONTENT:
${context}

QUESTION:
${message}
`;

    // STEP 3: GEMINI CALL
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
