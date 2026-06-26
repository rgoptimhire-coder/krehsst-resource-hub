import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const NOTION_VERSION = "2022-06-28";

function getPlainText(richText = []) {
  return richText.map(item => item.plain_text || "").join("");
}

function getPageTitle(page) {
  if (!page.properties) return "Untitled";

  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title?.length) {
      return getPlainText(prop.title);
    }
  }

  return "Untitled";
}

function blockToText(block) {
  const supportedTypes = [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "to_do",
    "toggle",
    "quote",
    "callout"
  ];

  if (!supportedTypes.includes(block.type)) {
    return "";
  }

  const data = block[block.type];

  if (!data?.rich_text) {
    return "";
  }

  return data.rich_text
    .map(item => item.plain_text || "")
    .join("");
}

async function getBlockChildren(blockId) {
  let allBlocks = [];
  let cursor;

  do {
    const url = new URL(
      `https://api.notion.com/v1/blocks/${blockId}/children`
    );

    url.searchParams.set("page_size", "100");

    if (cursor) {
      url.searchParams.set("start_cursor", cursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message || "Unable to fetch Notion blocks."
      );
    }

    allBlocks.push(...(data.results || []));

    cursor = data.next_cursor;

  } while (cursor);

  return allBlocks;
}

async function readPageContent(pageId, depth = 0) {
  if (depth > 2) return "";

  const blocks = await getBlockChildren(pageId);

  let content = "";

  for (const block of blocks) {

    const text = blockToText(block);

    if (text) {
      content += text + "\n";
    }

    if (block.has_children) {
      content += await readPageContent(
        block.id,
        depth + 1
      );
    }
  }

  return content;
}

async function searchNotionDocuments(query) {
  try {

    const response = await fetch(
      "https://api.notion.com/v1/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          page_size: 10,
          filter: {
            property: "object",
            value: "page"
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message || "Notion search failed."
      );
    }

    if (!data.results?.length) {
      return [];
    }

    const docs = [];

    for (const page of data.results) {

      const title = getPageTitle(page);

      let content = "";

      try {
        content = await readPageContent(page.id);
      } catch (e) {
        console.error(
          `Failed reading page ${title}:`,
          e.message
        );
      }

      docs.push({
        title,
        content
      });
    }

    return docs;

  } catch (err) {

    console.error(
      "Notion Search Error:",
      err.message
    );

    return [];
  }
}

async function isInternalContentRelevant(
  userMessage,
  context
) {

  try {

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash"
    });

    const prompt = `
USER QUESTION:
${userMessage}

DOCUMENT CONTENT:
${context.substring(0, 5000)}

Answer ONLY YES or NO.

Can this document content directly answer the user's question?
`;

    const result =
      await model.generateContent(prompt);

    const answer =
      result.response.text().trim().toUpperCase();

    return answer.includes("YES");

  } catch (error) {

    console.error(
      "Relevance Check Error:",
      error.message
    );

    return false;
  }
}

async function askGemini(
  userMessage,
  companyKnowledgeContext
) {

  const cleanMsg =
    userMessage.toLowerCase().trim();

  const greetings = [
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "test"
  ];

  if (
    greetings.includes(cleanMsg) ||
    cleanMsg.length < 3
  ) {
    return "Hello 👋 I am your KREHSST Resource Hub Assistant. How can I help you today?";
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
  });

  let relevant = false;

  if (
    companyKnowledgeContext &&
    companyKnowledgeContext.length > 100
  ) {
    relevant = await isInternalContentRelevant(
      userMessage,
      companyKnowledgeContext
    );
  }

  let prompt = "";

  if (relevant) {

    prompt = `
You are KREHSST Resource Hub Assistant.

Answer ONLY from the internal company content below.

Requirements:
- Use clean plain text
- No markdown symbols
- Use bullet points with "-"
- Summarize clearly
- Mention source document if possible
- Maximum 400 words

INTERNAL COMPANY CONTENT:

${companyKnowledgeContext}

USER QUESTION:

${userMessage}
`;

  } else {

    prompt = `
You are KREHSST Resource Hub Assistant.

No relevant internal content exists.

Provide a complete professional answer using your knowledge.

Start exactly with:

Data not available in Library, check alternate source below.

SUGGESTED EXTERNAL GUIDANCE:

Then provide the answer.

Requirements:
- Structured format
- Professional HR tone
- Bullet points
- Practical guidance
- Maximum 600 words

USER QUESTION:

${userMessage}
`;
  }

  try {

    const result =
      await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1500
        }
      });

    return result.response.text();

  } catch (error) {

    console.error(
      "Gemini Error:",
      error.message
    );

    return `
Data not available in Library, check alternate source below.

SUGGESTED EXTERNAL GUIDANCE:

System is temporarily unavailable. Please try again.
`;
  }
}

export default async function handler(
  req,
  res
) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        answer: "Only POST requests are allowed."
      });
    }

    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        answer: "Please enter a question."
      });
    }

    const docs =
      await searchNotionDocuments(message);

    const companyKnowledgeContext =
      docs.length > 0
        ? docs
            .slice(0, 5)
            .map(
              doc => `
DOCUMENT TITLE:
${doc.title}

CONTENT:
${doc.content.substring(0, 2000)}
`
            )
            .join("\n\n")
        : "";

    const answer =
      await askGemini(
        message,
        companyKnowledgeContext
      );

    return res.status(200).json({
      answer
    });

  } catch (error) {

    console.error(
      "Critical Error:",
      error.message
    );

    return res.status(200).json({
      answer: `
Data not available in Library, check alternate source below.

SUGGESTED EXTERNAL GUIDANCE:

The system encountered a temporary issue. Please try again.
`
    });
  }
}
