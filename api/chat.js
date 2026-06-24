```javascript
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash"
});

async function searchNotion(query) {
  const response = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      page_size: 10
    })
  });

  const data = await response.json();

  if (!data.results) {
    return "No Notion content found.";
  }

  let content = "";

  for (const page of data.results) {

    let title = "Untitled";

    try {
      if (page.properties) {
        const firstProp = Object.values(page.properties)[0];

        if (firstProp?.title?.length) {
          title = firstProp.title[0].plain_text;
        }
      }
    } catch (e) {}

    content += `
Title: ${title}
URL: ${page.url}
`;
  }

  return content || "No matching documents found.";
}

export default async function handler(req, res) {

  try {

    const { message } = req.body;

    const notionData = await searchNotion(message);

    const prompt = `
You are KREHSST Knowledge Assistant.

Answer ONLY from the provided Notion data.

If answer is unavailable say:
"Information not available in knowledge base."

NOTION DATA:
${notionData}

USER QUESTION:
${message}
`;

    const result = await model.generateContent(prompt);

    const response = await result.response;

    return res.status(200).json({
      answer: response.text()
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      answer: "Error searching knowledge base."
    });
  }
}
```
