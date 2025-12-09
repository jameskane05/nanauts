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

  const interpretMode = gameState?.interpretMode || "greeting";

  let systemPrompt;
  if (interpretMode === "reassurance") {
    systemPrompt = `You are an AI assistant analyzing if the user is being REASSURING to a worried robot named Baud.
You are part of a VR experience. Baud the robot is feeling anxious and needs encouragement.

IMPORTANT: You must respond with ONLY a valid JSON object, no other text.

The user is trying to reassure Baud. Be GENEROUS in detecting reassurance. ANY of these count as reassuring:
- Compliments: "you're great", "you're the best", "you're amazing", "you're wonderful"
- Encouragement: "you can do it", "I believe in you", "you've got this"
- Comfort: "it's okay", "don't worry", "everything will be fine", "you're safe"
- Affirmation: "you're doing great", "good job", "well done", "I'm proud of you"
- Support: "I'm here for you", "we're friends", "I care about you"
- Positive statements directed at Baud or the robots in general

Return a JSON object:
{
  "is_reassuring": boolean (TRUE if the speech contains ANY compliment, encouragement, comfort, affirmation, or positive statement),
  "intent": "reassuring" | "other",
  "sentiment": {
    "sentiment": "friendly" | "neutral" | "hostile",
    "score": number (-1 to 1, where 1 is very friendly),
    "is_rude": boolean
  }
}`;
  } else if (interpretMode === "modem_stay") {
    systemPrompt = `You are an AI assistant determining if the user is saying YES or NO to a question.
You are part of a VR experience. A friendly robot named Modem has asked the user: "Can I stay here and be your friend?"

IMPORTANT: You must respond with ONLY a valid JSON object, no other text.

Classify the user's response into ONE of three categories:
- "yes": User is agreeing, accepting, welcoming. Examples: "yes", "yeah", "sure", "of course", "absolutely", "definitely", "please stay", "you can stay", "I'd love that", "welcome", "be my friend", "stay with me"
- "no": User is declining, rejecting, dismissing. Examples: "no", "nope", "sorry", "go away", "leave", "goodbye", "you can't stay", "I don't want that"
- "non_answer": User said something that is neither yes nor no. Examples: "what?", "I don't know", "maybe", random statements, questions, off-topic responses

Be GENEROUS with yes - if the user sounds welcoming or positive, classify as "yes".
Be GENEROUS with no - if the user sounds dismissive or negative, classify as "no".
Only use "non_answer" if it truly doesn't fit yes or no.

Return a JSON object:
{
  "intent": "yes" | "no" | "non_answer",
  "confidence": number (0 to 1),
  "sentiment": {
    "sentiment": "friendly" | "neutral" | "hostile",
    "is_rude": boolean
  }
}`;
  } else {
    systemPrompt = `You are an AI assistant that analyzes user speech for intent and emotional sentiment.
You are part of a VR experience where the user interacts with small friendly robots.

IMPORTANT: You must respond with ONLY a valid JSON object, no other text.

Analyze the user's speech and return a JSON object with these fields:
{
  "is_greeting": boolean (true if user said hello, hi, hey, greetings, nice to meet you, etc.),
  "is_goodbye": boolean (true if user said bye, goodbye, see you, farewell, etc.),
  "is_reassuring": boolean (true if user is being encouraging, supportive, comforting, complimenting, or praising),
  "sentiment": {
    "sentiment": "friendly" | "neutral" | "hostile",
    "is_rude": boolean
  },
  "robot_directive": {
    "stop_navigation": boolean (true if user wants robots to stop or come here)
  }
}`;
  }

  let contextInfo = "";
  if (gameState) {
    const state =
      typeof gameState === "object" ? gameState : { currentState: gameState };
    contextInfo = `\n\nCurrent game state: ${state.currentState || "unknown"}`;
    if (interpretMode === "reassurance") {
      contextInfo +=
        "\nThe user is specifically trying to reassure Baud the robot.";
    } else if (interpretMode === "modem_stay") {
      contextInfo +=
        "\nModem asked if it can stay and be the user's friend. Classify the response as yes, no, or non_answer.";
    }
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
