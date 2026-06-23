import { GoogleGenerativeAI } from "@google/generative-ai";

// Gemini :contentReference[oaicite:0]{index=0}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite",
});

// ✅ YOUR REAL HR KNOWLEDGE (FROM YOUR NOTION PDFS)
const HR_KNOWLEDGE = `
WFH Policy:
Employees can work from home 2 days per week with manager approval.

Hybrid Work Policy:
3 days office + 2 days remote.

Holiday List:
1 Jan - New Year
26 Jan - Republic Day
15 Aug - Independence Day

Offer Management Process:
1. HR raises offer request
2. Manager approval
3. Salary validation
4. Offer letter generation
5. Candidate acceptance tracking

End-to-End Recruitment Process:
1. Requirement gathering
2. JD approval
3. Sourcing
4. Interview rounds
5. Final selection
6. Offer rollout
`;

export default async function handler(req, res) {
  try {
    const { message } = req.body;

    const prompt = `
You are HR assistant.

RULES:
- Use ONLY the knowledge below
- If not found, say "Not found in HR policy"

HR DATA:
${HR_KNOWLEDGE}

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
      answer: error.message,
    });
  }
}
