import { Client } from "@notionhq/client";
import { GoogleGenerativeAI } from "@google/generative-ai";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

const PAGE_ID = process.env.NOTION_PAGE_ID;

async function getNotionText() {
  const blocks = await notion.blocks.children.list({
    block_id: PAGE_ID,
  });

  let text = "";

  blocks.results.forEach((block) => {
    if (block.type === "paragraph") {
      text += block.paragraph.rich_text.map(t => t.plain_text).join("") + "\n";
    }
    if (block.type === "heading_1") {
      text += block.heading_1.rich_text.map(t => t.plain_text).join("") + "\n";
    }
    if (block.type === "heading_2") {
      text += block.heading_2.rich_text.map(t => t.plain_text).join("") + "\n";
    }
    if (block.type === "bulleted_list_item") {
      text += "- " + block.bulleted_list_item.rich_text.map(t => t.plain_text).join("") + "\n";
    }
  });

  return text;
}

export default async function handler(req, res) {
  try {
    const { message } = req.body;

    const context = await getNotionText();

    const prompt = `
You are HR assistant.

Only use this data:

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
