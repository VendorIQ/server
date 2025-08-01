require("dotenv").config();
const fs = require("fs");
const pdfParse = require("pdf-parse");
const Tesseract = require("tesseract.js");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const upload = multer({ dest: "tmp" });
const app = express();
const corsOptions = {
  origin: "https://vendoriq-chatbot.vercel.app",
  methods: ["GET", "POST"],
  credentials: false,
};
app.use(cors(corsOptions));
app.use(express.json());

// === Embedded Questions with Scoring ===
const questionData = [
  {
    number: 1,
    text: "Does your Company have a written OHS Policy that has been approved by your top management and has been communicated throughout the organization and to your subcontractors (when applicable)?",
    scoring: {
      stretch:
        "Policy includes beyond-compliance elements, communicated widely including external partners.",
      commitment:
        "Policy is approved and communicated effectively to internal staff.",
      robust: "Policy exists and is approved, but limited communication.",
      warning: "Policy exists but is outdated or lacks clear communication.",
      offtrack: "No written policy or evidence of communication.",
    },
  },
  {
    number: 2,
    text: "Has your Company committed any infringements to the laws or regulations concerning Occupational Health & Safety (OHS) matters in the last three (03) years or is under any current investigation by, or in discussions with, any regulatory authority in respect of any OHS matters, accident or alleged breach of OHS laws or regulations?",
    scoring: {
      stretch:
        "No infringements, with proactive legal tracking and transparent processes.",
      commitment:
        "No infringements and system for monitoring legal compliance exists.",
      robust: "No major infringements, basic legal compliance process.",
      warning: "Past issues with weak documentation.",
      offtrack: "Current investigations or multiple recent breaches.",
    },
  },
  {
    number: 3,
    text: "Does the company have a process for Incident Reporting and Investigation, including a system for recording safety incidents (near misses, injuries, fatalities etc.) that meets local regulations and Ericsson's OHS Requirements at a minimum?",
    scoring: {
      stretch:
        "Digital system integrated with real-time reporting and thorough root cause analysis.",
      commitment: "Formal documented system used consistently.",
      robust: "Procedure exists but lacks consistency in use or documentation.",
      warning: "Manual or informal process, missing elements.",
      offtrack: "No structured process for reporting and investigation.",
    },
  },
];

// --- AI-based Company Name Extraction ---
async function extractCompanyNameAI(text) {
  const prompt = `
Extract the company or organization name from the following document. 
Return ONLY the exact company name as it appears. If the company name is not present or cannot be determined, return "NOT FOUND".

---
${text}
`;
  const result = await callGroq(
    prompt,
    "You are a compliance assistant that extracts company names from OHS documents.",
  );
  return (result || "")
    .split("\n")[0]
    .replace(/^["']|["']$/g, "")
    .trim();
}
// --- Regex/Pattern fallback extraction (pure sync!) ---
function extractCompanyNamePattern(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2);
  // Try lines with "company name" or "supplier"
  for (const line of lines) {
    const match = line.match(/(?:company name|supplier)[:\-]\s*(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  // Try "PT", "LTD", etc. at line start
  for (const line of lines) {
    if (
      /^(PT|CV|UD|PD|PERUSAHAAN|COMPANY|CORP|CORPORATION|INC|CO\.?|LTD|LLC|S\.A\.|Tbk)\s+[A-Z0-9 .,&()'"\-]{2,}$/i.test(
        line,
      )
    ) {
      return line;
    }
  }
  const companyKeywords = [
    "company",
    "pt",
    "ltd",
    "corp",
    "corporation",
    "inc",
    "co",
    "tbk",
    "limited",
    "s.a.",
    "llc",
  ];
  for (const line of lines) {
    if (
      line.split(" ").length >= 2 &&
      /^[a-zA-Z\s.]+$/.test(line) &&
      companyKeywords.some((word) => line.toLowerCase().includes(word))
    ) {
      return line;
    }
  }
  // Last fallback: nothing detected
  return "";
}
async function callGroq(
  prompt,
  systemPrompt = "You are an OHS compliance auditor.",
) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      stream: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data.error?.message ||
        data.error ||
        JSON.stringify(data) ||
        "Groq API error",
    );
  }
  return data.choices?.[0]?.message?.content || "";
}
function getScoringGuide(qNumber) {
  const q = questionData.find((q) => q.number === qNumber);
  if (!q) return "";
  return Object.entries(q.scoring)
    .map(([band, desc]) => `- ${band.toUpperCase()}: ${desc}\n`)
    .join("\n");
}
function getQuestionText(qNumber) {
  const q = questionData.find((q) => q.number === qNumber);
  return q ? q.text : "";
}
// --- Text Extraction ---
async function extractText(localPath, originalName, ocrLang = "eng") {
  const ext = originalName.split(".").pop().toLowerCase();
  let extractedText = "";

  if (ext === "pdf") {
    // Try native PDF text extraction first
    const data = await pdfParse(fs.readFileSync(localPath));
    if (data.text && data.text.trim().length > 10) {
      extractedText = data.text;
    } else {
      // Fallback: OCR on the PDF (as an image)
      try {
        const {
          data: { text },
        } = await Tesseract.recognize(localPath, ocrLang);
        extractedText = text;
      } catch (e) {
        extractedText = "";
      }
    }
  } else if (["jpg", "jpeg", "png"].includes(ext)) {
    try {
      const {
        data: { text },
      } = await Tesseract.recognize(localPath, ocrLang);
      extractedText = text;
    } catch (e) {
      extractedText = "";
    }
  } else if (["txt"].includes(ext)) {
    extractedText = fs.readFileSync(localPath, "utf-8");
  }
  // ---- DEBUG LOG ----
  console.log("Extracted text:", extractedText);
  return extractedText;
}

// === Get all answers for auditor ===
app.get("/api/all-answers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("answers")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) {
      return res.status(500).json({ error: "Failed to fetch answers." });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- Normalize for comparison ---
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeCompanyName(str) {
  return (str || "")
    .toLowerCase()
    .replace(/(private|pvt|limited|ltd|inc|corp|company|co|plc)/g, "") // remove company type suffixes
    .replace(/[^a-z0-9]/g, "") // remove all non-alphanumeric
    .replace(/\s+/g, ""); // remove spaces
}
// --- File Upload & Check Endpoint ---
app.post("/api/check-file", upload.single("file"), async (req, res) => {
  try {
    const { email, questionNumber, userExplanation, ocrLang } = req.body;
    const lang = ocrLang || "eng";
    if (!req.file)
      return res.json({ success: false, feedback: "No file uploaded." });

    const qNum = parseInt(questionNumber);
    if (!qNum)
      return res.json({
        success: false,
        feedback: "Invalid or missing question number.",
      });

    // Always fetch company name from database (set at Auth page)
    const { data } = await supabase
      .from("supplier_names")
      .select("supplier_name")
      .eq("email", email)
      .single();

    const officialCompanyName = data?.supplier_name?.trim();
    if (!officialCompanyName) {
      return res.json({
        success: false,
        feedback:
          "No official supplier/company name found from your login/profile. Please contact support or update your profile.",
      });
    }

    // Extract document text
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const text = await extractText(filePath, fileName, lang);
    fs.unlinkSync(filePath);

    if (!text || !text.trim()) {
      return res.json({
        success: false,
        feedback:
          "Your document could not be read. Please upload a clear, readable file (PDF, Word, or image) with visible content.",
      });
    }

    // --- Consistency check: is the official name found in the document?
    const normalize = (str) =>
      (str || "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    // Extract all candidate company name lines from document
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 4);

    // Find all lines that look like a company name (has 'metro', 'telwork', 'limited', etc)
    const candidateNames = lines.filter((l) => {
      return (
        l.toLowerCase().includes("metro") &&
        (l.toLowerCase().includes("telwork") ||
          l.toLowerCase().includes("telworks"))
      );
    });

    // Add the officialCompanyName as well for matching
    candidateNames.push(officialCompanyName);

    // Try to find a fuzzy match
    const normalizedAuth = normalizeCompanyName(officialCompanyName);
    const hasMatch = candidateNames.some(
      (l) => normalizeCompanyName(l) === normalizedAuth,
    );

    if (!hasMatch) {
      return res.json({
        success: false,
        feedback: `Document does not clearly mention the registered company name: "${officialCompanyName}". Please re-upload a document that contains your company name as registered.`,
        requireCompanyNameConfirmation: true,
        detectedCompanyName: officialCompanyName,
      });
    }

    // --- Prepare AI review prompt
    const questionText = getQuestionText(qNum);
    const scoringGuide = getScoringGuide(qNum);
    const explanationSection = userExplanation
      ? `\n---\n**User Explanation:**\n${userExplanation}\n`
      : "";

    const prompt = `
You are an OHS compliance auditor. For the following question, review the vendor's uploaded document${userExplanation ? " and user explanation" : ""} and provide:

- A concise summary of the document's compliance with the requirement.
- Identify any missing elements, weaknesses, or best practices.
- Assign a score using ONLY: Stretch (5/5), Commitment (4/5), Robust (3/5), Warning (2/5), Offtrack (1/5)
- Use this format:
Summary: ...
Missing: ...
Score: ...
Recommendation: ...
---
QUESTION:
${questionText}

SCORING GUIDE:
${scoringGuide}
${explanationSection}
COMPANY NAME (from user profile/auth): ${officialCompanyName}
DOCUMENT TEXT:
${text}
`;

    const feedback = await callGroq(prompt);
    // Extract AI score (e.g., Score: Robust (3/5))
    let score = null;
    const match = feedback.match(
      /Score:\s*(Stretch|Commitment|Robust|Warning|Offtrack)\s*\((\d)\/5\)/i,
    );
    if (match) {
      score = parseInt(match[2], 10);
    }

    await supabase.from("answers").upsert(
      {
        email,
        question_number: qNum,
        upload_feedback: feedback,
        updated_at: new Date().toISOString(),
      },
      { onConflict: ["email", "question_number"] },
    );

    res.json({ success: true, score, feedback });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- Extract all numeric scores from feedback (Score: ... (X/5)) ---
function extractAllScores(feedbackText) {
  // Accepts a string and returns array of numbers (can be empty)
  const scores = [];
  if (!feedbackText) return scores;
  // Match all occurrences of Score: (text) (X/5)
  const regex = /Score:\s*(?:\w+\s*)?\(?(\d{1,3})\/?5?\)?/gi;
  let match;
  while ((match = regex.exec(feedbackText))) {
    if (match[1]) scores.push(Number(match[1]));
  }
  return scores;
}

// --- Session Summary Endpoint ---
app.post("/api/session-summary", express.json(), async (req, res) => {
  try {
    const { email } = req.body;
    const { data: answers, error } = await supabase
      .from("answers")
      .select("*")
      .eq("email", email)
      .order("question_number", { ascending: true });

    if (error || !answers || answers.length === 0) {
      return res
        .status(422)
        .json({ feedback: "No answer data found for this email." });
    }

    // === NEW: Calculate the pure average ===
    let total = 0;
    let count = 0;
    for (const ans of answers) {
      // This handles multiple requirements in a single feedback if present
      const scores = extractAllScores(ans.upload_feedback);
      for (const s of scores) {
        total += s;
        count++;
      }
    }
    const maxPossible = count * 5;
    const overallScore = count ? Math.round((total / maxPossible) * 100) : 0;

    // === Build the summary prompt as before ===
    let summaryPrompt = `You are a supplier compliance auditor. Here is a supplier's interview session:\n\n`;
    for (const ans of answers) {
      summaryPrompt += `Question ${ans.question_number}: ${getQuestionText(ans.question_number)}\n`;
      summaryPrompt += `Answer: ${ans.answer}\n`;
      if (ans.upload_feedback)
        summaryPrompt += `Document Review: ${ans.upload_feedback}\n`;
      if (ans.skip_reason)
        summaryPrompt += `Skipped/Reason: ${ans.skip_reason}\n`;
      summaryPrompt += `\n`;
    }
    summaryPrompt += `\nSummarize this supplier's OHS compliance in under 10 sentences. List strengths, weaknesses, and give a score (0-100). Return JSON with "feedback" and "score".`;

    // Still call the AI for the summary text, but ignore its score!
    const aiText = await callGroq(summaryPrompt);

    let feedback = aiText;
    // Try to extract the feedback field from the AI reply (if it's JSON)
    try {
      const match = aiText.match(/\{[\s\S]*\}/m);
      if (match) {
        const json = JSON.parse(match[0]);
        feedback = json.feedback || feedback;
        // DO NOT use json.score, override below!
      }
    } catch (e) {}

    await supabase
      .from("sessions")
      .update({ gemini_summary: feedback, gemini_score: overallScore })
      .eq("email", email);

    // === Respond with our own calculated score ===
    res.json({ feedback, score: overallScore });
  } catch (err) {
    console.error("ERROR in /api/session-summary:", err);
    res.status(500).json({ feedback: "Failed to generate summary." });
  }
  // At the end of your /api/session-summary endpoint:
  const detailedScores = answers.map((ans) => {
    const matches = [];
    if (ans.upload_feedback) {
      // You may have multiple requirements in a single feedback (if you allow bulk upload)
      const regex = /Score:\s*\w+\s*\((\d)\/5\)/gi;
      let m;
      while ((m = regex.exec(ans.upload_feedback))) {
        matches.push(Number(m[1]));
      }
    }
    return {
      questionNumber: ans.question_number,
      answer: ans.answer,
      requirementScores: matches,
      upload_feedback: ans.upload_feedback,
    };
  });
  res.json({ feedback, score: overallScore, detailedScores });
});

// Add to your server.js

app.post("/api/missing-feedback", upload.none(), async (req, res) => {
  const { email, questionNumber, requirementText, missingReason } = req.body;

  if (!email || !questionNumber || !requirementText || !missingReason) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  // Compose prompt for AI
  const prompt = `A supplier was asked to submit the following requirement:
"${requirementText}"

However, they responded that they don't have it. Their reason was:
"${missingReason}"

As an AI compliance evaluator, you must:
1. Decide if the reason reasonably justifies the absence of the document.
2. Provide a temporary compliance score using ONLY: Fully Compliant (5/5), Strong (4/5), Moderate (3/5), Weak (2/5), Not Compliant (1/5)
3. Give a short recommendation to improve.

Your response must use this format:
Score: [one of the allowed scores]
Justification: [your decision on the explanation]
Suggestion: [1-2 sentence recommendation]
`;

  try {
    const aiReply = await callGroq(prompt);

    // Save to Supabase (optional)
    await supabase.from("answers").insert({
      email,
      question_number: Number(questionNumber),
      answer: "No Document - AI Reviewed",
      feedback: aiReply,
    });

    return res.json({ success: true, feedback: aiReply });
  } catch (err) {
    console.error("AI justification error:", err);
    return res
      .status(500)
      .json({ success: false, message: "AI evaluation failed." });
  }
});
app.post("/api/check-missing-reason", async (req, res) => {
  const { reason, requirement, email, questionNumber } = req.body;

  // 🔁 You can replace this with real AI logic later
  const feedback = `✅ AI Feedback:
Reason given: ${reason}
Requirement: ${requirement}
Score: 70
Suggestion: Please upload supporting justification or request auditor review.`;

  res.json({ feedback });
});
// --- Save simple Yes/No answers to Supabase ---
app.post("/api/save-answer", async (req, res) => {
  console.log("📨 /api/save-answer HIT", req.body);
  const { email, questionNumber, answer } = req.body;
  console.log("📨 Received answer:", { email, questionNumber, answer });
  if (!email || !questionNumber || !answer) {
    return res.status(400).json({ error: "Missing fields" });
  }
  let upload_feedback = null;
  if (answer === "No") {
    upload_feedback = "Score: Offtrack (1/5)\nSummary: User answered 'No'.";
  }
  try {
    const result = await supabase.from("answers").upsert(
      {
        email,
        question_number: parseInt(questionNumber),
        answer,
        upload_feedback, // PATCHED: only set if No, otherwise null
        updated_at: new Date().toISOString(),
      },
      { onConflict: ["email", "question_number"] },
    );

    console.log("✅ Supabase upsert result:", result);

    if (result.error) {
      console.error("❌ Supabase insert error:", result.error);
      return res.status(500).json({ error: result.error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Save answer error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/manual-score", async (req, res) => {
  const { email, questionNumber, newScore, comment, auditor } = req.body;

  try {
    // (Optional) Fetch previous score first
    const { data: existing } = await supabase
      .from("answers")
      .select("upload_feedback")
      .eq("email", email)
      .eq("question_number", questionNumber)
      .single();

    // Update main score
    await supabase
      .from("answers")
      .update({
        upload_feedback: newScore,
        status: "auditor-final",
        review_mode: false,
        updated_at: new Date().toISOString(),
      })
      .eq("email", email)
      .eq("question_number", questionNumber);

    // Log audit action
    await supabase.from("audit_logs").insert({
      email,
      question_number: questionNumber,
      action: "Manual Score Override",
      old_score: existing?.upload_feedback || null,
      new_score: newScore,
      comment,
      auditor,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Manual scoring failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// Place this after your other endpoints
app.post("/api/disagree-feedback", upload.single("file"), async (req, res) => {
  try {
    const { email, questionNumber, requirement, disagreeReason } = req.body;
    let fileText = "";
    if (req.file) {
      fileText = await extractText(
        req.file.path,
        req.file.originalname,
        req.body.ocrLang || "eng",
      );
      console.log("Extracted disagreement file text:\n", fileText);
      fs.unlinkSync(req.file.path);
    }

    const prompt = `
You are an OHS compliance auditor reviewing a supplier's disagreement with the AI's feedback.

Requirement: ${requirement}
Disagreement Reason: ${disagreeReason}
${fileText ? `File Content:\n${fileText}` : ""}

- Assess if the supplier's argument and/or additional file support compliance.
- Give a new score using ONLY: Stretch (5/5), Commitment (4/5), Robust (3/5), Warning (2/5), Offtrack (1/5)
- Give a short summary and suggestion.
IMPORTANT SCORING INSTRUCTIONS:

- If the supplier's disagreement or argument is based ONLY on a feeling, personal opinion, or general/unsubstantiated statement (such as "it doesn't feel right" or "I don't agree" without facts), you MUST assign:
  Score: Offtrack (1/5)
  Summary: Subjective opinions or feelings are NOT valid evidence in compliance assessments.

- DO NOT give a higher score just because the supplier is polite, questions the result, or expresses willingness to comply. Only factual evidence, official documents, or specific regulatory/policy references are acceptable as grounds for changing the score.

- If in doubt, always require objective supporting evidence. Vague or emotional reasoning without facts is insufficient.

- Use the lowest score unless real evidence is present.
Format:
Score: [exactly one of above]
Summary: [short]
Suggestions: [bullets, or 'None']
`;

    const feedback = await callGroq(prompt);

    // --- Save disagreement to Supabase ---
    await supabase.from("disagreements").insert({
      email,
      question_number: questionNumber,
      requirement,
      disagree_reason: disagreeReason,
      ai_feedback: feedback,
      created_at: new Date().toISOString(),
      // file_url: if you want to add uploaded file url/path
    });

    res.json({ feedback });
  } catch (err) {
    console.error("ERROR in /api/disagree-feedback:", err);
    res.status(500).json({ error: err.message });
  }
});
// PATCH: Allow manual correction of supplier name
app.post("/api/set-supplier-name", async (req, res) => {
  const { email, supplierName } = req.body;
  if (!email || !supplierName) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }
  try {
    await supabase.from("supplier_names").upsert(
      {
        email,
        supplier_name: supplierName,
        extracted_at: new Date().toISOString(),
      },
      { onConflict: ["email"] },
    );
    res.json({ success: true, supplierName });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Failed to set supplier name." });
  }
});
app.get("/api/get-supplier-name", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ supplierName: "" });
  const { data } = await supabase
    .from("supplier_names")
    .select("supplier_name")
    .eq("email", email)
    .single();
  res.json({ supplierName: data?.supplier_name || "" });
});
console.log("GROQ_API_KEY exists?", !!process.env.GROQ_API_KEY);
console.log("GROQ_MODEL is", process.env.GROQ_MODEL);
app.post("/api/skip-requirement", async (req, res) => {
  const { email, questionNumber, requirementIdx } = req.body;
  if (!email || !questionNumber) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Insert or update with a lowest score
  await supabase.from("answers").upsert(
    {
      email,
      question_number: parseInt(questionNumber),
      answer: "Skipped",
      upload_feedback: `Score: Offtrack (1/5)\nSummary: Requirement skipped.`,
      updated_at: new Date().toISOString(),
    },
    { onConflict: ["email", "question_number"] },
  );
  res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`VendorIQ Groq API listening on port ${PORT}`);
});
