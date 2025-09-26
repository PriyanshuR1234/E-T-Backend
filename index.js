require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const WebSocket = require("ws");
const expressWs = require("express-ws");
const Twilio = require("twilio");

const app = express();
expressWs(app);

app.use(express.json());
app.use(cors());

// -------------------- ENV VARS --------------------
const {
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  BASE_URL,
  GEMINI_API_KEY,
  PYTHON_API_URL,
  PORT,
} = process.env;

const SERVER_PORT = PORT || 3000;
const PUBLIC_URL = BASE_URL || `http://localhost:${SERVER_PORT}`;

// -------------------- Twilio Client --------------------
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// -------------------- HEALTH CHECK --------------------
app.get("/", (req, res) => {
  res.json({ message: "Server is running ✅" });
});

// -------------------- TWILIO INBOUND --------------------
app.all("/incoming-call-eleven", (req, res) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  res.type("text/xml").send(twimlResponse);
});

// -------------------- TWILIO MEDIA STREAM --------------------
app.ws("/media-stream", (ws, req) => {
  console.log("[Server] Twilio connected to media stream.");
  let streamSid = null;

  const elevenLabsWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
  );

  elevenLabsWs.on("open", () => console.log("[II] Connected to ElevenLabs"));
  elevenLabsWs.on("close", () => console.log("[II] Disconnected"));
  elevenLabsWs.on("error", (err) => console.error("[II] Error:", err));

  elevenLabsWs.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === "audio" && message.audio_event?.audio_base_64) {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: message.audio_event.audio_base_64 },
          })
        );
      } else if (message.type === "interruption") {
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      } else if (message.type === "ping" && message.ping_event?.event_id) {
        elevenLabsWs.send(
          JSON.stringify({ type: "pong", event_id: message.ping_event.event_id })
        );
      }
    } catch (err) {
      console.error("[II] Parse error:", err);
    }
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log(`[Twilio] Stream started: ${streamSid}`);
      } else if (data.event === "media" && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(
          JSON.stringify({
            user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
          })
        );
      } else if (data.event === "stop") {
        elevenLabsWs.close();
      }
    } catch (err) {
      console.error("[Twilio] Error:", err);
    }
  });

  ws.on("close", () => elevenLabsWs.close());
});

// -------------------- OUTBOUND CALL --------------------
app.post("/make-outbound-call", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Phone number required" });

  try {
    const call = await twilioClient.calls.create({
      url: `${PUBLIC_URL}/incoming-call-eleven`,
      to,
      from: TWILIO_PHONE_NUMBER,
    });
    console.log(`[Twilio] Outbound call initiated: ${call.sid}`);
    res.json({ message: "Call initiated", callSid: call.sid });
  } catch (err) {
    console.error("[Twilio] Call error:", err.message);
    res.status(500).json({ error: "Failed to initiate call" });
  }
});

// -------------------- CALL API ROUTE --------------------
app.post("/call", async (req, res) => {
  const { to } = req.body;
  try {
    const response = await axios.post(
      `${PUBLIC_URL}/make-outbound-call`,
      { to },
      { headers: { "Content-Type": "application/json" } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ message: "Failed to initiate call" });
  }
});

// -------------------- SUBMIT TEST ROUTE --------------------
app.get("/submit", (req, res) => {
  const { ph, tds, orp, color, mq3, mq135, mq136, mq138 } = req.query;
  const ans = ph * tds * orp * color;
  res.send(`submitted ${ph},${tds},${orp},${color},${mq3},${mq135},${mq136},${mq138} and results are ${ans}`);
});

// -------------------- API ROUTE FOR FRONTEND --------------------
app.post("/api/analyze", async (req, res) => {
  try {
    const mappedData = {
      ph: parseFloat(req.body.ph),
      tds: parseFloat(req.body.tds),
      orp: parseFloat(req.body.orp),
      r: parseFloat(req.body.color_r),
      g: parseFloat(req.body.color_g),
      b: parseFloat(req.body.color_b),
      bme688: parseFloat(req.body.bme688),
    };

    // Call Python backend
    const pythonResp = await axios.post(`${PYTHON_API_URL}/predict`, mappedData);
    const charts = pythonResp.data.charts || null;
    const pythonText = { ...pythonResp.data };
    delete pythonText.charts;

    let geminiText = "";

    // Only send text data to Gemini
    if (GEMINI_API_KEY) {
      try {
        const prompt = `Hello`; // simple test prompt or you can use real text data
        const geminiResp = await axios.post(
          "https://generativelanguage.googleapis.com/v1beta/models/text-bison-001:generateText",
          { prompt },
          { headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GEMINI_API_KEY } }
        );
        geminiText = geminiResp.data?.candidates?.[0]?.output || "";
      } catch (err) {
        console.warn("⚠️ Gemini failed, returning Python data only:", err.message);
        geminiText = "Gemini analysis unavailable.";
      }
    } else {
      geminiText = "Gemini API key not configured.";
    }

    res.json({ ...pythonText, note: geminiText, charts });
  } catch (err) {
    console.error("API Analyze error:", err.message);
    res.status(500).json({ error: "Failed to fetch analysis results" });
  }
});

// -------------------- START SERVER --------------------
app.listen(SERVER_PORT, () => {
  console.log(`[Server] Listening on port ${SERVER_PORT}`);
});
