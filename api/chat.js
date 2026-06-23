import { GoogleGenerativeAI } from "@google/generative-ai";

// =====================
// GEMINI SETUP
// =====================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// =====================
// SIMPLE FAST CHAT API
// (NO PDF / NO NOTION — STABLE BASELINE)
// =====================
export default async function handler(req, res) {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        answer: "No message provided",
      });
    }

    const prompt = `
You are KREHSST HR Assistant.

Answer clearly and concisely:

Question: ${message}
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
