import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

export default async function handler(req, res) {
  try {
    const { message } = req.body;

    console.log("REQUEST RECEIVED:", message);

    const result = await model.generateContent(message);
    const response = await result.response;

    return res.status(200).json({
      answer: response.text(),
    });

  } catch (error) {
    console.log("ERROR:", error);

    return res.status(200).json({
      answer: "ERROR: " + error.message,
    });
  }
}
