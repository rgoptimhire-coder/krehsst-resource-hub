import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        answer: "Only POST method is allowed",
      });
    }

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        answer: "Please type your question.",
      });
    }

    const prompt = `
You are KREHSST HR Knowledge Assistant.

Answer this question clearly:

${message}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return res.status(200).json({
      answer: response.text(),
    });

  } catch (error) {
    return res.status(500).json({
      answer: "Backend error: " + error.message,
    });
  }
}
