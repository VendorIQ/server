require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// ====== CONFIGURATION ======
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bucket = 'uploads';
// Dynamically set these for your user/session:
const userEmail = process.argv[2]; // Pass email as first command-line arg
const sessionId = process.argv[3]; // (Optional) Pass sessionId as second arg if needed

if (!userEmail) {
  console.error("Please provide the user's email as the first argument.");
  process.exit(1);
}

// Path to this user's folder in storage
const userFolder = `uploads/${sessionId ? sessionId + '_' : ''}${userEmail}`;

// ====== HELPERS ======
async function listAllFiles(bucket, folderPath = '') {
  const { data, error } = await supabase.storage.from(bucket).list(folderPath, { limit: 100 });
  if (error) throw error;
  let files = [];
  if (!data) return files;
  for (const item of data) {
    if (!item.id) {
      // It's a folder
      const subfolderFiles = await listAllFiles(bucket, (folderPath ? folderPath + '/' : '') + item.name);
      files = files.concat(subfolderFiles);
    } else {
      // It's a file
      files.push((folderPath ? folderPath + '/' : '') + item.name);
    }
  }
  return files;
}

async function downloadFile(storagePath, localPath) {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) throw error;
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  return localPath;
}

async function extractText(localPath) {
  const ext = localPath.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const data = await pdfParse(fs.readFileSync(localPath));
    return data.text;
  } else if (['jpg', 'jpeg', 'png'].includes(ext)) {
    const { data: { text } } = await Tesseract.recognize(localPath, 'eng');
    return text;
  } else {
    return '';
  }
}

// Optional: Try to extract a score from the Gemini response
function extractScore(text) {
  const match = text.match(/score\s*[:=]?\s*(\d{1,3})/i);
  return match ? parseInt(match[1], 10) : null;
}

// ====== MAIN FUNCTION ======
async function main() {
  // 1. List all files for this user (recursively)
  const files = await listAllFiles(bucket, userFolder);
  if (!files.length) {
    console.log('No files found for this user or wrong folder path.');
    return;
  }

  let combinedText = '';
  let tempFiles = [];
  // 2. Download and extract text
  for (let storagePath of files) {
    try {
      const filename = path.basename(storagePath);
      const localPath = path.join('/tmp', filename);
      await downloadFile(storagePath, localPath);
      tempFiles.push(localPath);
      const text = await extractText(localPath);
      combinedText += `\n=== Content from ${filename} ===\n${text}\n`;
    } catch (err) {
      console.error(`Error processing ${storagePath}:`, err.message);
    }
  }
  if (!combinedText.trim()) {
    console.log("No readable content found in any files.");
    return;
  }

  // 3. Get Gemini AI feedback
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = `
  You are an OHS compliance expert with Auditor knowledge.
  Review all these compliance files and provide:
  - A clear, readable summary (Markdown is OK)
  - Actionable suggestions
  - And always finish with: Score: X/100 (for example: Score: 82/100)

  Only return the above, nothing else.
  
  FILES:\n\n${combinedText}\n\n---\nFeedback:`;
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const feedback = response.text();

  // Optional: Extract score (if you want)
  const score = extractScore(feedback);

  // 4. Save Gemini feedback to Supabase (update the session row)
  // You can identify the row by email or sessionId; adjust as needed for your schema
  const { error: updateError } = await supabase
    .from('sessions')
    .update({
      gemini_summary: feedback,
      gemini_score: score
    })
    .eq('email', userEmail); // or .eq('id', sessionId) if using sessionId

  if (updateError) {
    console.error('Error saving feedback to Supabase:', updateError.message);
  } else {
    console.log('Gemini feedback saved to Supabase!');
  }

  // 5. Clean up temp files
  for (let f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
}

main().catch(e => console.error(e));
