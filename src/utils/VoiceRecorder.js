/**
 * VoiceRecorder.js - MICROPHONE AUDIO CAPTURE
 * =============================================================================
 *
 * ROLE: Wrapper around MediaRecorder API for capturing voice input. Handles
 * microphone permission requests and converts recordings to base64 for API calls.
 *
 * KEY RESPONSIBILITIES:
 * - Request microphone permission (with helpful error for Cursor browser)
 * - Start/stop audio recording via MediaRecorder
 * - Convert audio blob to base64 string for API submission
 * - Track recording state and permission status
 *
 * RECORDING FLOW:
 * 1. requestMicrophonePermission() - one-time permission request
 * 2. startVoiceRecording() - creates MediaRecorder, begins capture
 * 3. stopVoiceRecording() - stops capture, returns audio blob
 * 4. audioBlobToBase64() - converts blob for API transmission
 *
 * BROWSER SUPPORT:
 * Requires getUserMedia API. Cursor browser doesn't support mic permissions -
 * logs helpful message directing users to Chrome for testing.
 *
 * USAGE: Instantiated by AIManager, controlled via button press/release
 * =============================================================================
 */

import { Logger } from "./Logger.js";

export class VoiceRecorder {
  constructor() {
    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioStream = null;
    this.recordingStartTime = null;
    this.recordedAudioBlob = null;
    this.microphonePermissionGranted = false;
    this.onRecordingStopped = null; // Callback when recording stops
    this.logger = new Logger("VoiceRecorder", false);
  }

  async requestMicrophonePermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.microphonePermissionGranted = true;
      stream.getTracks().forEach((track) => track.stop());
      this.logger.log("Microphone permission granted");
      return true;
    } catch (error) {
      this.microphonePermissionGranted = false;
      this.logger.warn("Microphone permission denied:", error);
      // Helpful message for Cursor browser users
      console.warn(
        "[VoiceRecorder] 💡 Cursor browser doesn't support mic permissions. " +
          "For audio testing, open http://localhost:5173 in Chrome instead."
      );
      return false;
    }
  }

  async startVoiceRecording() {
    if (!this.microphonePermissionGranted) {
      const granted = await this.requestMicrophonePermission();
      if (!granted) {
        this.logger.warn("Cannot record: microphone permission denied");
        return false;
      }
    }

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      this.mediaRecorder = new MediaRecorder(this.audioStream, {
        mimeType: "audio/webm;codecs=opus",
      });

      const audioChunks = [];
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
        this.logger.log(
          `Recording stopped, size: ${this.recordedAudioBlob.size} bytes`
        );
        if (this.onRecordingStopped) {
          this.onRecordingStopped(this.recordedAudioBlob);
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      this.logger.log("Voice recording started");
      return true;
    } catch (error) {
      this.logger.error("Failed to start recording:", error);
      this.isRecording = false;
      return false;
    }
  }

  async stopVoiceRecording() {
    if (!this.isRecording || !this.mediaRecorder) return null;

    try {
      this.mediaRecorder.stop();
      this.mediaRecorder = null;

      if (this.audioStream) {
        this.audioStream.getTracks().forEach((track) => track.stop());
        this.audioStream = null;
      }

      this.isRecording = false;
      const recordingDuration = (
        (Date.now() - this.recordingStartTime) /
        1000
      ).toFixed(1);
      this.recordingStartTime = null;

      await new Promise((resolve) => setTimeout(resolve, 100));

      return this.recordedAudioBlob;
    } catch (error) {
      this.logger.error("Error stopping recording:", error);
      this.isRecording = false;
      return null;
    }
  }

  getRecordingDuration() {
    if (!this.recordingStartTime) return 0;
    return (Date.now() - this.recordingStartTime) / 1000;
  }

  async audioBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
