/**
 * ApiClient.js - HTTP CLIENT FOR AI BACKEND SERVICES
 * =============================================================================
 *
 * ROLE: Handles all HTTP communication with the SAM3 segmentation server,
 * including object detection, 3D model generation, audio transcription, and
 * text interpretation via Llama.
 *
 * KEY RESPONSIBILITIES:
 * - sendToAPI(): Image + text prompts -> SAM3 detections + depth map
 * - sendVoiceToAPI(): Image + audio -> voice-guided segmentation
 * - generate3DModel(): Image + label -> GLB model via Trellis
 * - transcribeAudio(): Audio blob -> text via OpenAI Whisper API
 * - interpretText(): Transcription -> intent/sentiment via AWS Bedrock (Llama 3.3)
 *   Includes game state context and evaluates: is_greeting, is_reassuring, is_goodbye
 *
 * API ENDPOINTS (configured in config.js):
 * - /segment/json: SAM3 image segmentation
 * - /segment/voice: Voice-guided segmentation
 * - /generate3d: Trellis 3D model generation
 * - OpenAI /v1/audio/transcriptions: OpenAI Whisper audio transcription
 * - AWS Bedrock Converse API: Llama 3.3 intent/sentiment analysis
 *
 * ERROR HANDLING: Logs detailed error info for SSL, network, and API failures.
 * Stores last responses on window for debugging (window._lastApiResponse, etc.)
 *
 * USAGE: Instantiated by AIManager, methods called for each AI operation
 * =============================================================================
 */

import {
  API_URL,
  API_3D_URL,
  API_VOICE_URL,
  API_INTERPRET_URL,
  OPENAI_API_KEY,
  OPENAI_TRANSCRIBE_URL,
  AWS_REGION,
  AWS_BEDROCK_API_KEY,
  AWS_BEDROCK_MODEL_ID,
  TEXT_PROMPTS,
  THRESHOLD,
  ENABLE_VIDEO_MODE,
  LAMBDA_PROXY_URL,
  USE_LAMBDA_PROXY,
} from "./config.js";
import { Logger } from "../utils/Logger.js";

export class ApiClient {
  constructor(sessionId = null, frameIndex = 0) {
    this.sessionId = sessionId;
    this.frameIndex = frameIndex;
    this.logger = new Logger("ApiClient", true);
    this.bedrockEndpoint = `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${encodeURIComponent(
      AWS_BEDROCK_MODEL_ID
    )}/converse`;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  setFrameIndex(frameIndex) {
    this.frameIndex = frameIndex;
  }

  async sendToAPI(imageBase64) {
    this.logger.log("Sending to API...");
    const startTime = performance.now();

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: imageBase64,
          text_prompts: TEXT_PROMPTS,
          threshold: THRESHOLD,
          return_depth_map: true,
          session_id: ENABLE_VIDEO_MODE ? this.sessionId : null,
          frame_index: ENABLE_VIDEO_MODE ? this.frameIndex : null,
        }),
      });

      const elapsed = performance.now() - startTime;
      this.logger.log(`API response received (${elapsed.toFixed(0)}ms)`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`API error ${response.status}:`, errorText);
        return null;
      }

      const result = await response.json();
      this.logger.log(`Found ${result.detections?.length || 0} detections`);
      return result;
    } catch (error) {
      this.logger.error("API request failed:", error);

      if (error.message.includes("SSL") || error.message.includes("ERR_SSL")) {
        this.logger.error(
          "SSL Certificate Error:",
          "\n  The server's SSL certificate is invalid or incompatible.",
          "\n  Options:",
          "\n  1. Fix the SSL certificate on your server (recommended)",
          "\n  2. For development, you can use HTTP on localhost only",
          "\n  3. Add the certificate to your browser's trusted certificates",
          "\n  Current API URL:",
          API_URL
        );
      } else if (
        error.message.includes("Failed to fetch") ||
        error.message.includes("network")
      ) {
        this.logger.error(
          "Network Error:",
          "\n  Could not connect to the API server.",
          "\n  Check that:",
          "\n  1. The server is running at",
          API_URL,
          "\n  2. The server is accessible from this device",
          "\n  3. Firewall allows connections on port 8002"
        );
      }

      return null;
    }
  }

  async sendVoiceToAPI(imageBase64, audioBase64) {
    try {
      const response = await fetch(API_VOICE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: imageBase64,
          audio: audioBase64,
          threshold: THRESHOLD,
          use_full_transcription: true,
          return_depth_map: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Voice segmentation failed: ${response.status} ${errorText}`
        );
      }

      const result = await response.json();

      // Store for console download helper
      window._lastApiResponse = result;

      return result;
    } catch (error) {
      this.logger.error("Voice API request failed:", error);
      throw error;
    }
  }

  async generate3DModel(imageBase64, label) {
    try {
      const response = await fetch(API_3D_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: imageBase64,
          text_prompt: label,
          threshold: THRESHOLD,
          format: "glb",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `3D generation failed: ${response.status} ${errorText}`
        );
      }

      const result = await response.json();
      this.logger.log(
        `3D model generated successfully (format: ${result.format})`
      );
      return result;
    } catch (error) {
      this.logger.error("3D generation API failed:", error);
      throw error;
    }
  }

  async transcribeAudio(audioBlob) {
    try {
      let transcription;

      if (USE_LAMBDA_PROXY) {
        // Use Lambda proxy (production) - send base64 audio
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Audio = btoa(
          String.fromCharCode(...new Uint8Array(arrayBuffer))
        );

        const response = await fetch(`${LAMBDA_PROXY_URL}/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio, filename: "audio.webm" }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Transcription failed: ${response.status} ${errorText}`
          );
        }

        const result = await response.json();
        transcription = result.text || "";
      } else {
        // Direct API call (local dev)
        const formData = new FormData();
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", "whisper-1");

        const response = await fetch(OPENAI_TRANSCRIBE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Transcription failed: ${response.status} ${errorText}`
          );
        }

        const result = await response.json();
        transcription = result.text || "";
      }

      this.logger.log(`Transcribed: "${transcription}"`);

      const formattedResult = { transcription };
      window._lastTranscription = formattedResult;
      return formattedResult;
    } catch (error) {
      this.logger.error("Transcription API failed:", error);
      throw error;
    }
  }

  async interpretText(
    transcription,
    conversationHistory = null,
    gameState = null
  ) {
    try {
      let result;

      if (USE_LAMBDA_PROXY) {
        // Use Lambda proxy (production)
        this.logger.log(`Sending to Lambda proxy for interpretation...`);
        this.logger.log(`User message: "${transcription}"`);

        // Extract only serializable gameState fields (avoid circular refs from ECS world)
        const safeGameState = gameState
          ? {
              currentState: gameState.currentState,
              greetingResult: gameState.greetingResult,
              introPlayed: gameState.introPlayed,
              callAnswered: gameState.callAnswered,
              interpretMode: gameState.interpretMode,
            }
          : null;

        const response = await fetch(`${LAMBDA_PROXY_URL}/interpret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcription, gameState: safeGameState }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Lambda proxy error ${response.status}: ${errorText}`
          );
        }

        result = await response.json();
        this.logger.log(`Lambda response:`, JSON.stringify(result, null, 2));
      } else {
        // Direct Bedrock API call (local dev)
        if (!AWS_BEDROCK_API_KEY) {
          throw new Error(
            "AWS Bedrock API key not set. Set VITE_AWS_BEDROCK_API_KEY in .env"
          );
        }

        const systemPrompt = `You are an AI assistant that analyzes user speech for intent and emotional sentiment. 
You must respond with valid JSON only, no other text.

Analyze the user's speech and classify:

1. INTENT - One of:
- greeting: User is saying hello, hi, or any form of greeting
- farewell: User is saying goodbye
- command: User is giving an instruction or command
- question: User is asking a question
- acknowledgment: User is acknowledging something (yes, okay, sure, etc.)
- reassuring: User is providing reassurance, comfort, encouragement, praise, or compliments. Examples include: "it's okay", "don't worry", "you're doing great", "you're the best", "I believe in you", "you're amazing", "everything will be fine", "I'm proud of you", "you're so great", "that's wonderful", "good job", "well done"
- negative: User is declining or saying no
- other: Anything else

2. SENTIMENT - Analyze the emotional tone:
- sentiment: "friendly", "neutral", "unfriendly", or "hostile"
- score: -1.0 (very hostile) to 1.0 (very friendly)
- is_rude: true if the user is being rude, dismissive, insulting, or hostile
- tone_description: Brief description of the detected emotional tone

3. NAME CORRECTION - The user may be addressing robots named "Blit", "Baud", or "Modem".
If you detect sound-alikes that were likely meant to be these names, correct them:
- "Blitz", "Split", "Bit", "Slit", "Lit" → "Blit"
- "Bod", "Bad", "Bawd", "Bot", "Bought", "Bob" → "Baud"  
- "Mode", "Moden" → "Modem"
If corrections were made, include the corrected text in "corrected_transcription".

4. GAME STATE EVALUATION - Based on the current game state, evaluate these specific intents:
- is_greeting: true if this is a friendly greeting (hello, hi, hey, etc.)
- is_reassuring: true if this speech is reassuring, comforting, encouraging, praising, or complimenting. This includes expressions of support, affirmation, admiration, or positivity directed at someone. Be generous - if the user is saying something kind or supportive, mark it as reassuring.
- is_goodbye: true if this is a farewell (goodbye, bye, see you, etc.)

Response format (JSON only):
{
    "intent": "<intent_type>",
    "confidence": <0.0-1.0>,
    "is_greeting": <true/false>,
    "is_reassuring": <true/false>,
    "is_goodbye": <true/false>,
    "suggested_action": "<action_name>",
    "response_text": "<appropriate response to the user>",
    "corrected_transcription": "<corrected text if names were fixed, otherwise null>",
    "robot_directive": {
        "stop_navigation": <true/false>,
        "face_user": <true/false>
    },
    "sentiment": {
        "sentiment": "<friendly/neutral/unfriendly/hostile>",
        "score": <-1.0 to 1.0>,
        "is_rude": <true/false>,
        "tone_description": "<brief description>"
    }
}

Rules for robot_directive:
- stop_navigation: true for greetings, questions, commands that need attention
- face_user: true for greetings and direct conversation

Rules for sentiment:
- Consider tone, word choice, and context
- "friendly": Warm, polite, kind, enthusiastic speech
- "neutral": Matter-of-fact, no strong emotion
- "unfriendly": Dismissive, curt, impatient, mildly rude
- "hostile": Insulting, aggressive, very rude, profanity`;

        let contextInfo = "";
        if (gameState) {
          const state =
            typeof gameState === "object"
              ? gameState
              : { currentState: gameState };
          contextInfo = `\n\nCurrent game state: ${
            state.currentState || "unknown"
          }`;
        }

        const userMessage = `Analyze this speech: "${transcription}"${contextInfo}`;

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

        this.logger.log(
          `Sending to AWS Bedrock (model: ${AWS_BEDROCK_MODEL_ID})...`
        );
        this.logger.log(`User message: "${transcription}"`);

        const response = await fetch(this.bedrockEndpoint, {
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
        const responseText =
          apiResult.output?.message?.content?.[0]?.text || "";

        this.logger.log(`Raw Bedrock response:`, responseText);

        if (!responseText) {
          throw new Error("Empty response from Bedrock");
        }

        try {
          const jsonMatch =
            responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) ||
            responseText.match(/(\{[\s\S]*\})/);
          const jsonText = jsonMatch ? jsonMatch[1] : responseText;
          result = JSON.parse(jsonText);
        } catch (parseError) {
          this.logger.error(
            "Failed to parse Bedrock response as JSON:",
            responseText
          );
          throw new Error(
            `Invalid JSON response from Bedrock: ${parseError.message}`
          );
        }
      }

      // Ensure required fields exist with defaults
      const formattedResult = {
        transcription: result.transcription || transcription,
        corrected_transcription: result.corrected_transcription || null,
        intent: result.intent || "unknown",
        confidence: result.confidence || 0.5,
        is_greeting:
          result.is_greeting !== undefined
            ? result.is_greeting
            : result.intent === "greeting",
        is_reassuring:
          result.is_reassuring !== undefined
            ? result.is_reassuring
            : result.intent === "reassuring",
        is_goodbye:
          result.is_goodbye !== undefined
            ? result.is_goodbye
            : result.intent === "farewell",
        suggested_action: result.suggested_action || "continue",
        response_text: result.response_text || "I heard you.",
        robot_directive: result.robot_directive || {
          stop_navigation: false,
          face_user: false,
        },
        sentiment: {
          sentiment: result.sentiment?.sentiment || "neutral",
          is_rude: result.sentiment?.is_rude || false,
          tone_description: result.sentiment?.tone_description || "",
          score:
            result.sentiment?.score !== undefined
              ? result.sentiment.score
              : 0.0,
        },
      };

      this.logger.log(
        `Interpreted result:`,
        JSON.stringify(formattedResult, null, 2)
      );

      window._lastInterpretResponse = formattedResult;
      return formattedResult;
    } catch (error) {
      this.logger.error("Interpretation failed:", error);
      throw error;
    }
  }
}
