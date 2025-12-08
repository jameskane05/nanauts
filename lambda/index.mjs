const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AWS_BEDROCK_API_KEY = process.env.AWS_BEDROCK_API_KEY;
const AWS_REGION = process.env.BEDROCK_REGION || "us-east-1";
const BEDROCK_MODEL_ID = "us.meta.llama3-3-70b-instruct-v1:0";

export async function handler(event) {
  // CORS headers are handled by Lambda Function URL config - don't duplicate
  const headers = { "Content-Type": "application/json" };

  const path = event.rawPath || event.path;
  const body = JSON.parse(event.body || "{}");

  try {
    if (path === "/transcribe") {
      return await handleTranscribe(body, headers);
    } else if (path === "/interpret") {
      return await handleInterpret(body, headers);
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Not found" }),
      };
    }
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
}

async function handleTranscribe(body, headers) {
  const { audio, filename } = body;

  if (!audio) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing audio data" }),
    };
  }

  // Decode base64 audio
  const audioBuffer = Buffer.from(audio, "base64");

  // Create form data for OpenAI
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const formParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${
      filename || "audio.webm"
    }"\r\nContent-Type: audio/webm\r\n\r\n`,
    audioBuffer,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`,
  ];

  const formBody = Buffer.concat([
    Buffer.from(formParts[0]),
    formParts[1],
    Buffer.from(formParts[2]),
  ]);

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: formBody,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ text: result.text }),
  };
}

async function handleInterpret(body, headers) {
  const { transcription, gameState } = body;

  if (!transcription) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing transcription" }),
    };
  }

  const systemPrompt = `You are an AI assistant that analyzes user speech for intent and emotional sentiment.
You are part of a VR experience where the user interacts with small friendly robots.

IMPORTANT: You must respond with ONLY a valid JSON object, no other text.

Analyze the user's speech and return a JSON object with these fields:
{
  "is_greeting": boolean (true if user said hello, hi, hey, greetings, nice to meet you, etc.),
  "is_goodbye": boolean (true if user said bye, goodbye, see you, farewell, etc.),
  "is_reassuring": boolean (true if user is being calming, supportive, comforting to the robots),
  "sentiment": {
    "sentiment": "friendly" | "neutral" | "hostile",
    "is_rude": boolean
  },
  "robot_directive": {
    "stop_navigation": boolean (true if user wants robots to stop or come here)
  }
}`;

  let contextInfo = "";
  if (gameState) {
    const state =
      typeof gameState === "object" ? gameState : { currentState: gameState };
    contextInfo = `\n\nCurrent game state: ${state.currentState || "unknown"}`;
  }

  const userMessage = `Analyze this speech: "${transcription}"${contextInfo}`;

  const bedrockEndpoint = `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${encodeURIComponent(
    BEDROCK_MODEL_ID
  )}/converse`;

  const requestBody = {
    messages: [
      {
        role: "user",
        content: [{ text: `${systemPrompt}\n\n${userMessage}` }],
      },
    ],
    inferenceConfig: {
      maxTokens: 512,
      temperature: 0.3,
      topP: 0.9,
    },
  };

  const response = await fetch(bedrockEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AWS_BEDROCK_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bedrock API error ${response.status}: ${errorText}`);
  }

  const apiResult = await response.json();
  const responseText = apiResult.output?.message?.content?.[0]?.text || "";

  if (!responseText) {
    throw new Error("Empty response from Bedrock");
  }

  // Parse JSON from response
  let result;
  try {
    const jsonMatch =
      responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) ||
      responseText.match(/(\{[\s\S]*\})/);
    const jsonText = jsonMatch ? jsonMatch[1] : responseText;
    result = JSON.parse(jsonText);
  } catch (parseError) {
    throw new Error(
      `Invalid JSON response from Bedrock: ${parseError.message}`
    );
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result),
  };
}
