const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios'); // <- for study APIs
require('dotenv').config();

const { extractTextFromPDF } = require('./utils/extracttext.js');
const { getGeminiResponse } = require('./utils/gemini.js');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // serve dashboard.html + assets

// Ensure upload folder exists
const uploadDir = './pdfs';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Multer setup
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * 1) Upload PDF → Extract Text → Summary + MCQs
 */
app.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const filePath = req.file.path;
    const text = await extractTextFromPDF(filePath);

    // Summary
    const summaryPrompt = `Summarize the following PDF content in 6–10 bullet points using simple language:\n\n${text}`;
    const summary = await getGeminiResponse(summaryPrompt);

    // MCQs
    const mcqPrompt = `
Generate exactly 5 multiple choice questions in valid JSON format:
[
  {
    "question": "string",
    "topic": "string",
    "options": ["string", "string", "string", "string"],
    "correct": 0
  }
]
Rules:
- "topic" must be a short, clear name.
- "correct" is the index (0–3) of the correct answer in options.
- Output ONLY valid JSON.
Base strictly on this text:
${text}
    `;
    let mcqs = [];
    const mcqsRaw = await getGeminiResponse(mcqPrompt);
    const jsonMatch = mcqsRaw?.match?.(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        mcqs = JSON.parse(
          jsonMatch[0]
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']')
            .replace(/\\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      } catch (err) {
        console.error('❌ MCQ JSON parse error:', err.message);
      }
    }

    // async cleanup
    fs.unlink(filePath, (e) => e && console.error('cleanup error:', e));

    res.json({
      summary: summary || 'No summary returned.',
      mcqs: Array.isArray(mcqs) ? mcqs : []
    });
  } catch (err) {
    console.error('❌ Upload processing error:', err);
    res.status(500).json({ error: 'Failed to process PDF.' });
  }
});

/**
 * 2) Evaluate Quiz → Weak Topics → Easy Notes
 */
app.post('/evaluate', async (req, res) => {
  try {
    const { mcqs = [], answers = [], context = '' } = req.body;
    if (!mcqs.length) return res.status(400).json({ error: 'No MCQs provided' });

    let score = 0;
    const topicStats = {};
    mcqs.forEach((q, i) => {
      const topic = (q.topic || 'General').trim();
      if (!topicStats[topic]) topicStats[topic] = { correct: 0, total: 0 };
      const isCorrect = answers[i] === q.correct;
      topicStats[topic].total++;
      if (isCorrect) {
        topicStats[topic].correct++;
        score++;
      }
    });

    const weakTopics = [];
    Object.keys(topicStats).forEach(topic => {
      const { correct, total } = topicStats[topic];
      const acc = total ? correct / total : 0;
      topicStats[topic].accuracy = acc;
      if (acc < 0.5) weakTopics.push(topic);
    });

    // Generate notes per weak topic (can be merged to one call if you want to save quota)
    const notes = {};
    for (const topic of weakTopics) {
      try {
        const notesPrompt = `
Write beginner-friendly revision notes for: "${topic}".
${context ? `Context:\n${context}` : ''}
- Max 180 words
- 4–6 bullet points
- Include 1 real-world example
- Output only notes
        `;
        notes[topic] = await getGeminiResponse(notesPrompt) || 'No notes generated.';
      } catch (err) {
        console.error(`❌ Error generating notes for ${topic}:`, err.message);
        notes[topic] = 'Notes unavailable.';
      }
    }

    res.json({
      score,
      total: mcqs.length,
      percentage: Number(((score / mcqs.length) * 100).toFixed(2)),
      topicStats,
      weakTopics,
      notes
    });
  } catch (err) {
    console.error('❌ Evaluation error:', err);
    res.status(500).json({ error: 'Failed to evaluate quiz.' });
  }
});

/**
 * 3) Retake Quiz → MCQs Only for Weak Topics
 */
app.post('/retake', async (req, res) => {
  try {
    const { topics = [], context = '' } = req.body;
    if (!topics.length) return res.status(400).json({ error: 'No topics provided' });

    const mcqPrompt = `
Generate 5 MCQs only for topics: ${topics.join(', ')}
Format:
[
  {
    "question": "string",
    "topic": "string",
    "options": ["string", "string", "string", "string"],
    "correct": 0
  }
]
Rules:
- All questions must have a "topic" from the list.
- Base strictly on topics and this context:
${context}
- Output only valid JSON
    `;

    let mcqs = [];
    const mcqsRaw = await getGeminiResponse(mcqPrompt);
    const jsonMatch = mcqsRaw?.match?.(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        mcqs = JSON.parse(
          jsonMatch[0]
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']')
            .replace(/\\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      } catch (err) {
        console.error('❌ Retake MCQ JSON parse error:', err.message);
      }
    }

    res.json({ mcqs: Array.isArray(mcqs) ? mcqs : [] });
  } catch (err) {
    console.error('❌ Retake generation error:', err);
    res.status(500).json({ error: 'Failed to generate retake quiz.' });
  }
});

/**
 * 4) Study Materials (NEW) → AI Notes + YouTube + Web Resources
 * GET /study?topic=Normalization
 */
app.get('/study', async (req, res) => {
  try {
    const topic = String(req.query.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'Missing topic' });

    // 4.1 AI Notes (Gemini)
    const notesPrompt = `
Create simple study notes for the topic "${topic}".
- 5–7 bullet points in plain language
- 1 short real-world example
- If applicable, include 1 key formula/definition
- Keep under 180 words
`;
    const notes = await getGeminiResponse(notesPrompt);

    // 4.2 YouTube videos (optional)
    const youtube = await fetchYouTube(topic);

    // 4.3 Web resources (optional)
    const resources = await fetchWebResources(topic);

    res.json({ notes, youtube, resources });
  } catch (err) {
    console.error('❌ Study error:', err);
    res.status(500).json({ error: 'Failed to fetch study materials.' });
  }
});

// Helper: YouTube search (returns [] if no key)
// Helper: YouTube search (improved version)
// Helper: Google Custom Search (returns [] if no keys)
async function fetchWebResources(q) {
  const CSE_KEY = process.env.GOOGLE_CSE_API_KEY;
  const CSE_ID = process.env.GOOGLE_CSE_ID; // "cx"
  if (!CSE_KEY || !CSE_ID) return [];
  try {
    const url = 'https://www.googleapis.com/customsearch/v1';
    const { data } = await axios.get(url, {
      params: {
        key: CSE_KEY,
        cx: CSE_ID,
        q,
        num: 6,
        safe: 'active',
        fileType: 'pdf',
        // search PDFs and general resources
      }
    });
    return (data.items || []).map(it => ({
      title: it.title,
      link: it.link
    }));
  } catch (e) {
    console.error('Google CSE error:', e.response?.data || e.message);
    return [];
  }
}

// Fetch YouTube videos for a topic
async function fetchYouTube(query) {
  const YT_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_KEY) return [];

  try {
    const url = 'https://www.googleapis.com/youtube/v3/search';
    const { data } = await axios.get(url, {
      params: {
        key: YT_KEY,
        q: query,
        part: 'snippet',
        maxResults: 5,
        type: 'video'
      }
    });

    return (data.items || []).map(item => ({
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      thumbnail: item.snippet.thumbnails?.medium?.url || ''
    }));
  } catch (err) {
    console.error('YouTube API error:', err.response?.data || err.message);
    return [];
  }
}


app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});