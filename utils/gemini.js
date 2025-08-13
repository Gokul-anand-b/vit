// utils/gemini.js
const axios = require('axios');
require('dotenv').config();

async function getGeminiResponse(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY is missing in .env");
    return '';
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

  try {
    const response = await axios.post(
      url,
      { contents: [ { parts: [ { text: prompt } ] } ] },
      { headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey } }
    );
    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    console.error("❌ Gemini API error:", err.response?.data || err.message);
    return '';
  }
}

module.exports = { getGeminiResponse };


