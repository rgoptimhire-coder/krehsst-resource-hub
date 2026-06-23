import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// =====================
// STATIC KNOWLEDGE (TEMP FIX)
// =====================
// 👉 Put your PDF text manually here (for now)
const PDF_TEXT = `
KREHSST HR POLICY

Holiday List:
- 1 Jan: New Year
- 26 Jan: Republic Day
- 15 Aug: Independence Day

Paid Leave: 18 days per year
Sick Leave: 10 days per year
Casual Leave: 6 days per year
`;

export default async function handler(req, res) {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ answer: "No message provided" });
    }

    const prompt = `
You are an HR assistant.

RULES:
- Use ONLY the HR policy below
- If answer not present, say "Not found in policy"

HR DATA:
${PDF_TEXT}

QUESTION:
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
