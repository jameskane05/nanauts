import { audioContext, createPanner, getMasterVolume } from "./audioContext.js";

export class RobotVoice {
  /**
   * @param {Object} character - Character config from robotCharacters.js
   */
  constructor(character = null) {
    this.isSpeaking = false;
    this.panner = createPanner();
    this.panner.connect(audioContext.destination);
    this.position = { x: 0, y: 0, z: 0 };

    // Character-specific settings
    this.character = character;
    this.characterId = character?.id || "default";
    this.characterName = character?.name || "Robot";

    // Pitch multiplier from semitone offset (e.g., -10 semitones = 5 whole steps down)
    const semitoneOffset = character?.pitchOffset || 0;
    this.pitchMultiplier = Math.pow(2, semitoneOffset / 12);

    // Personality affects voice characteristics
    this.personality = character?.personality || {};
  }

  // Apply pitch multiplier to a frequency
  _freq(baseFreq) {
    return baseFreq * this.pitchMultiplier;
  }

  setPosition(x, y, z) {
    this.position = { x, y, z };
    if (this.panner.positionX) {
      this.panner.positionX.setValueAtTime(x, audioContext.currentTime);
      this.panner.positionY.setValueAtTime(y, audioContext.currentTime);
      this.panner.positionZ.setValueAtTime(z, audioContext.currentTime);
    } else {
      this.panner.setPosition(x, y, z);
    }
  }

  playNote(
    frequency,
    duration,
    delay = 0,
    volume = 0.05,
    type = "sine",
    pitchBend = 0
  ) {
    // Apply character pitch multiplier
    const adjustedFreq = this._freq(frequency);
    const adjustedBend = pitchBend * this.pitchMultiplier;

    const osc = audioContext.createOscillator();
    osc.type = type;

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0, 0);

    // Apply master volume
    const finalVolume = volume * getMasterVolume();

    osc.connect(gain);
    gain.connect(this.panner);

    const startTime = audioContext.currentTime + delay;
    const endTime = startTime + duration;

    osc.frequency.setValueAtTime(adjustedFreq, startTime);
    if (pitchBend !== 0) {
      osc.frequency.linearRampToValueAtTime(
        adjustedFreq + adjustedBend,
        endTime
      );
    }

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(finalVolume, startTime + 0.015);
    gain.gain.setValueAtTime(finalVolume, endTime - 0.02);
    gain.gain.linearRampToValueAtTime(0, endTime);

    osc.start(startTime);
    osc.stop(endTime + 0.01);
  }

  random(min, max) {
    return min + Math.random() * (max - min);
  }

  randomInt(min, max) {
    return Math.floor(this.random(min, max + 1));
  }

  pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  content() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const noteCount = this.randomInt(2, 4);
    const baseFreq = this.random(400, 600);
    const volume = this.random(0.12, 0.18);
    let time = 0;

    for (let i = 0; i < noteCount; i++) {
      const freq = baseFreq + this.random(-30, 50);
      const dur = this.random(0.06, 0.12);
      const bend = this.random(-10, 20);
      this.playNote(freq, dur, time, volume, "sine", bend);
      time += dur + this.random(0.03, 0.08);
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  excited() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const noteCount = this.randomInt(4, 7);
    let freq = this.random(500, 700);
    const volume = this.random(0.15, 0.22);
    let time = 0;

    for (let i = 0; i < noteCount; i++) {
      const dur = this.random(0.04, 0.08);
      const bend = this.random(20, 60);
      this.playNote(freq, dur, time, volume, "sine", bend);
      freq += this.random(30, 80);
      time += dur + this.random(0.02, 0.05);
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  sad() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const noteCount = this.randomInt(2, 3);
    let freq = this.random(350, 450);
    const volume = this.random(0.12, 0.16);
    let time = 0;

    for (let i = 0; i < noteCount; i++) {
      const dur = this.random(0.15, 0.25);
      const bend = this.random(-60, -30);
      this.playNote(freq, dur, time, volume, "sine", bend);
      freq -= this.random(30, 60);
      time += dur + this.random(0.1, 0.2);
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  angry() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const noteCount = this.randomInt(3, 5);
    const baseFreq = this.random(250, 350);
    const volume = this.random(0.15, 0.22);
    let time = 0;

    for (let i = 0; i < noteCount; i++) {
      const freq = baseFreq + this.random(-20, 20);
      const dur = this.random(0.05, 0.1);
      this.playNote(freq, dur, time, volume, "sawtooth", 0);
      if (Math.random() > 0.5) {
        this.playNote(freq * 1.05, dur, time, volume * 0.5, "square", 0);
      }
      time += dur + this.random(0.02, 0.06);
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  curious() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const baseFreq = this.random(450, 550);
    const volume = this.random(0.12, 0.18);

    this.playNote(baseFreq, 0.1, 0, volume, "sine", 80);
    this.playNote(baseFreq + 100, 0.15, 0.12, volume, "sine", 30);

    setTimeout(() => {
      this.isSpeaking = false;
    }, 400);
  }

  effort() {
    // Jump effort sound - low growl building up slowly, rising, then cut off
    // Like a human going "rrrrRRRRRR-HUP!"
    const baseFreq = this.random(100, 150); // Start very low
    const volume = this.random(0.15, 0.22);
    const growlDuration = this.random(0.28, 0.38); // Longer buildup
    const riseFreq = this.random(280, 380);

    // Low rumbling growl (sawtooth for grit)
    const growlOsc = audioContext.createOscillator();
    growlOsc.type = "sawtooth";
    const growlGain = audioContext.createGain();
    const growlFilter = audioContext.createBiquadFilter();
    growlFilter.type = "lowpass";
    growlFilter.frequency.value = 350;

    growlOsc.connect(growlFilter);
    growlFilter.connect(growlGain);
    growlGain.connect(this.panner);

    const now = audioContext.currentTime;
    const finalVol = volume * getMasterVolume();

    // Growl starts very low/quiet, builds slowly then accelerates
    growlOsc.frequency.setValueAtTime(this._freq(baseFreq), now);
    growlOsc.frequency.setValueAtTime(
      this._freq(baseFreq * 1.1),
      now + growlDuration * 0.5
    ); // Slow start
    growlOsc.frequency.exponentialRampToValueAtTime(
      this._freq(baseFreq * 1.8),
      now + growlDuration
    ); // Accelerate

    // Volume builds exponentially - starts barely audible
    growlGain.gain.setValueAtTime(finalVol * 0.1, now);
    growlGain.gain.setValueAtTime(finalVol * 0.25, now + growlDuration * 0.4);
    growlGain.gain.exponentialRampToValueAtTime(
      finalVol * 0.8,
      now + growlDuration * 0.85
    );
    growlGain.gain.linearRampToValueAtTime(0, now + growlDuration);

    // Filter opens up as it builds
    growlFilter.frequency.setValueAtTime(250, now);
    growlFilter.frequency.exponentialRampToValueAtTime(
      600,
      now + growlDuration * 0.8
    );

    growlOsc.start(now);
    growlOsc.stop(now + growlDuration + 0.01);

    // Rising "HUP" at the end - sharp attack, quick release
    const hupDelay = growlDuration * this.random(0.75, 0.9);
    const hupDuration = this.random(0.08, 0.14);
    const hupPitch = this.random(60, 120); // How much it rises

    this.playNote(
      riseFreq,
      hupDuration,
      hupDelay,
      volume * 1.2,
      "triangle",
      hupPitch
    );

    // Optional second harmonic for richness
    if (Math.random() > 0.4) {
      this.playNote(
        riseFreq * 1.5,
        hupDuration * 0.8,
        hupDelay + 0.01,
        volume * 0.4,
        "sine",
        hupPitch * 0.8
      );
    }

    // Occasional extra grunt variation
    if (Math.random() > 0.6) {
      const extraDelay = hupDelay + hupDuration * 0.5;
      this.playNote(
        riseFreq * 0.8,
        0.04,
        extraDelay,
        volume * 0.3,
        "square",
        -20
      );
    }
  }

  inquisitive() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const volume = 0.22;
    let time = 0;

    // Minor/chromatic intervals for questioning feel
    const questionScale = [0, 2, 3, 5, 7, 8, 10, 12]; // Minor scale
    const rootFreq = this.pick([350, 400, 450, 500]);

    const scaleFreq = (degree) =>
      rootFreq * Math.pow(2, questionScale[degree % questionScale.length] / 12);

    // Pick 1-3 random questioning patterns
    const patterns = [
      "rising_question",
      "hmm",
      "double_take",
      "warble_up",
      "stutter_rise",
      "swoop",
    ];
    const numPatterns = this.randomInt(1, 3);
    const selectedPatterns = [];
    for (let i = 0; i < numPatterns; i++) {
      selectedPatterns.push(this.pick(patterns));
    }

    for (const pattern of selectedPatterns) {
      const patternVolume = volume * this.random(0.85, 1.0);

      if (pattern === "rising_question") {
        // Classic "huh?" rising inflection
        const startDeg = this.randomInt(0, 3);
        const endDeg = startDeg + this.randomInt(3, 5);
        const noteCount = this.randomInt(2, 4);

        for (let i = 0; i < noteCount; i++) {
          const progress = i / (noteCount - 1);
          const deg = Math.floor(startDeg + (endDeg - startDeg) * progress);
          const freq = scaleFreq(deg);
          const dur =
            i === noteCount - 1
              ? this.random(0.12, 0.2)
              : this.random(0.06, 0.1);
          const bend =
            i === noteCount - 1 ? this.random(60, 120) : this.random(10, 30);
          this.playNote(freq, dur, time, patternVolume, "sine", bend);
          time += dur * 0.7;
        }
        time += 0.05;
      } else if (pattern === "hmm") {
        // Thoughtful "hmm" - sustained note with slight wobble
        const freq = scaleFreq(this.randomInt(2, 5));
        const dur = this.random(0.2, 0.35);
        this.playNote(
          freq,
          dur,
          time,
          patternVolume * 0.9,
          "sine",
          this.random(-20, 40)
        );

        // Add a questioning uptick at the end
        if (Math.random() > 0.4) {
          this.playNote(
            freq * 1.15,
            0.08,
            time + dur * 0.8,
            patternVolume * 0.7,
            "sine",
            50
          );
        }
        time += dur + 0.03;
      } else if (pattern === "double_take") {
        // "Wha-what?" double chirp
        const freq1 = scaleFreq(this.randomInt(3, 5));
        const freq2 = freq1 * this.random(1.1, 1.25);

        this.playNote(freq1, 0.06, time, patternVolume, "sine", 30);
        time += 0.08;
        this.playNote(freq1, 0.04, time, patternVolume * 0.8, "sine", 20);
        time += 0.06;
        this.playNote(
          freq2,
          0.12,
          time,
          patternVolume,
          "sine",
          this.random(40, 80)
        );
        time += 0.15;
      } else if (pattern === "warble_up") {
        // Rapid ascending warble
        const startFreq = scaleFreq(0);
        const warbleCount = this.randomInt(4, 8);

        for (let i = 0; i < warbleCount; i++) {
          const progress = i / warbleCount;
          const freq = startFreq * (1 + progress * 0.6);
          const dur = 0.03 + this.random(0, 0.02);
          this.playNote(
            freq,
            dur,
            time,
            patternVolume * (0.7 + progress * 0.3),
            "sine",
            10
          );
          time += dur;
        }
        time += 0.02;
      } else if (pattern === "stutter_rise") {
        // Stuttering rising notes like "uh-uh-uh?"
        const startDeg = this.randomInt(1, 3);
        const stutterCount = this.randomInt(2, 4);

        for (let i = 0; i < stutterCount; i++) {
          const freq = scaleFreq(startDeg + i);
          const dur = 0.05;
          this.playNote(freq, dur, time, patternVolume, "sine", 15);
          time += dur + 0.04;
        }
        // Final questioning note
        this.playNote(
          scaleFreq(startDeg + stutterCount + 1),
          0.12,
          time,
          patternVolume,
          "sine",
          70
        );
        time += 0.15;
      } else if (pattern === "swoop") {
        // Big questioning swoop up
        const startFreq = scaleFreq(this.randomInt(0, 2));
        const dur = this.random(0.15, 0.25);
        const bendAmount = this.random(200, 400);
        this.playNote(startFreq, dur, time, patternVolume, "sine", bendAmount);
        time += dur + 0.02;
      }

      // Small gap between patterns
      time += this.random(0.02, 0.05);
    }

    // Lead-in note - lower by several whole tones
    const leadInFreq = scaleFreq(this.randomInt(0, 1)); // Low in the scale
    this.playNote(leadInFreq, 0.1, time, volume * 0.7, "sine", 10);
    time += 0.12;

    // Always end with a long questioning bend up an octave
    const finalFreq = scaleFreq(this.randomInt(1, 2)); // Start low
    const finalDur = this.random(0.4, 0.6);
    // Bend up approximately one octave (frequency doubles)
    const octaveBend = finalFreq; // Bend amount = starting freq means it ends at 2x
    this.playNote(finalFreq, finalDur, time, volume * 0.9, "sine", octaveBend);
    time += finalDur + 0.05;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 150);
  }

  acknowledge() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const baseFreq = this.random(500, 600);
    const volume = 0.15;

    this.playNote(baseFreq, 0.08, 0, volume, "sine", 20);
    this.playNote(baseFreq + 80, 0.1, 0.1, volume, "sine", 10);

    setTimeout(() => {
      this.isSpeaking = false;
    }, 300);
  }

  sad() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const volume = 0.2;
    let time = 0;

    // Minor scale with flattened notes for melancholy
    const sadScale = [0, 2, 3, 5, 7, 8, 10, 12];
    const rootFreq = this.pick([250, 280, 300, 320]); // Lower root for sadness

    const scaleFreq = (degree) =>
      rootFreq * Math.pow(2, sadScale[degree % sadScale.length] / 12);

    // Pick 1-3 sad patterns
    const patterns = ["sigh", "descend", "whimper", "lonely", "droop", "sob"];
    const numPatterns = this.randomInt(1, 3);
    const selectedPatterns = [];
    for (let i = 0; i < numPatterns; i++) {
      selectedPatterns.push(this.pick(patterns));
    }

    for (const pattern of selectedPatterns) {
      const patternVolume = volume * this.random(0.8, 1.0);

      if (pattern === "sigh") {
        // Long descending sigh
        const startFreq = scaleFreq(this.randomInt(4, 6));
        const dur = this.random(0.4, 0.6);
        this.playNote(
          startFreq,
          dur,
          time,
          patternVolume,
          "sine",
          this.random(-80, -150)
        );
        time += dur + 0.1;
      } else if (pattern === "descend") {
        // Slow descending notes
        const startDeg = this.randomInt(5, 7);
        const noteCount = this.randomInt(3, 5);

        for (let i = 0; i < noteCount; i++) {
          const freq = scaleFreq(startDeg - i);
          const dur = this.random(0.15, 0.25); // Slower notes
          const bend = this.random(-20, -40);
          this.playNote(
            freq,
            dur,
            time,
            patternVolume * (1 - i * 0.1),
            "sine",
            bend
          );
          time += dur + this.random(0.08, 0.15); // Longer gaps
        }
      } else if (pattern === "whimper") {
        // Small wobbling whimper
        const freq = scaleFreq(this.randomInt(2, 4));
        const whimperCount = this.randomInt(2, 4);

        for (let i = 0; i < whimperCount; i++) {
          const dur = this.random(0.08, 0.12);
          const wobble = this.random(-15, 15);
          this.playNote(
            freq + wobble,
            dur,
            time,
            patternVolume * 0.7,
            "sine",
            this.random(-10, -30)
          );
          time += dur + 0.06;
        }
        time += 0.05;
      } else if (pattern === "lonely") {
        // Single sustained lonely note
        const freq = scaleFreq(this.randomInt(3, 5));
        const dur = this.random(0.3, 0.5);
        this.playNote(
          freq,
          dur,
          time,
          patternVolume * 0.85,
          "sine",
          this.random(-10, -30)
        );
        time += dur + 0.15;
      } else if (pattern === "droop") {
        // Quick droop down
        const startFreq = scaleFreq(this.randomInt(4, 6));
        this.playNote(
          startFreq,
          0.2,
          time,
          patternVolume,
          "sine",
          this.random(-100, -180)
        );
        time += 0.25;
      } else if (pattern === "sob") {
        // Stuttering sob
        const freq = scaleFreq(this.randomInt(2, 4));
        const sobCount = this.randomInt(2, 3);

        for (let i = 0; i < sobCount; i++) {
          this.playNote(freq, 0.06, time, patternVolume * 0.6, "sine", -20);
          time += 0.1;
        }
        // Trailing sad note
        this.playNote(freq * 0.9, 0.2, time, patternVolume * 0.5, "sine", -40);
        time += 0.25;
      }

      // Longer gaps between patterns (sad = slower)
      time += this.random(0.1, 0.2);
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 200);
  }

  angry() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const volume = 0.28; // Louder
    let time = 0;

    // Minor scale for angry tension
    const angryScale = [0, 2, 3, 5, 7, 8, 10, 12];
    const rootFreq = this.pick([450, 500, 550, 600]); // Higher pitch

    const scaleFreq = (degree) =>
      rootFreq * Math.pow(2, angryScale[degree % angryScale.length] / 12);

    // Pick 2-4 angry patterns (more aggressive)
    const patterns = [
      "growl",
      "burst",
      "staccato",
      "screech",
      "rumble",
      "snap",
    ];
    const numPatterns = this.randomInt(2, 4);
    const selectedPatterns = [];
    for (let i = 0; i < numPatterns; i++) {
      selectedPatterns.push(this.pick(patterns));
    }

    for (const pattern of selectedPatterns) {
      const patternVolume = volume * this.random(0.9, 1.0);

      if (pattern === "growl") {
        // Aggressive growl
        const freq = scaleFreq(this.randomInt(2, 4));
        const dur = this.random(0.35, 0.55);
        this.playNote(
          freq,
          dur,
          time,
          patternVolume,
          "sawtooth",
          this.random(-20, 40)
        );
        time += dur + 0.06;
      } else if (pattern === "burst") {
        // Angry burst
        const burstCount = this.randomInt(4, 7);
        const baseFreq = scaleFreq(this.randomInt(3, 6));

        for (let i = 0; i < burstCount; i++) {
          const freq = baseFreq + this.random(-50, 50);
          const dur = 0.08 + this.random(0, 0.05);
          this.playNote(freq, dur, time, patternVolume, "square", 0);
          time += dur + 0.04;
        }
        time += 0.06;
      } else if (pattern === "staccato") {
        // Sharp staccato jabs
        const jabCount = this.randomInt(3, 5);

        for (let i = 0; i < jabCount; i++) {
          const freq = scaleFreq(this.randomInt(4, 7));
          this.playNote(
            freq,
            0.1,
            time,
            patternVolume,
            "square",
            this.random(-20, 20)
          );
          time += 0.18;
        }
      } else if (pattern === "screech") {
        // High pitched screech
        const startFreq = scaleFreq(this.randomInt(6, 8));
        const dur = this.random(0.25, 0.4);
        this.playNote(
          startFreq,
          dur,
          time,
          patternVolume * 0.85,
          "sawtooth",
          this.random(100, 200)
        );
        time += dur + 0.06;
      } else if (pattern === "rumble") {
        // Agitated rumble
        const freq = scaleFreq(this.randomInt(3, 5));
        const rumbleCount = this.randomInt(4, 7);

        for (let i = 0; i < rumbleCount; i++) {
          const dur = 0.1;
          this.playNote(
            freq + this.random(-30, 30),
            dur,
            time,
            patternVolume * 0.9,
            "sawtooth",
            this.random(-10, 10)
          );
          time += dur + 0.02;
        }
        time += 0.08;
      } else if (pattern === "snap") {
        // Sharp snapping sound
        const freq = scaleFreq(this.randomInt(5, 7));
        this.playNote(freq, 0.06, time, patternVolume, "square", 50);
        time += 0.12;
        this.playNote(
          freq * 0.7,
          0.08,
          time,
          patternVolume * 0.8,
          "square",
          -30
        );
        time += 0.12;
      }

      // Gaps between patterns
      time += this.random(0.06, 0.12);
    }

    // 50% chance of final aggressive punctuation
    if (Math.random() > 0.5) {
      const finishFreq = scaleFreq(this.randomInt(5, 7));
      this.playNote(
        finishFreq,
        0.25,
        time,
        volume,
        "sawtooth",
        this.random(-30, 50)
      );
      time += 0.3;
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  happy() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    const volume = 0.26;
    let time = 0;

    // Major scale intervals (in semitones from root)
    const majorScale = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];
    const rootFreq = this.pick([400, 450, 500, 550, 600]); // Random root note

    // Helper to get frequency from scale degree
    const scaleFreq = (degree) =>
      rootFreq * Math.pow(2, majorScale[degree % majorScale.length] / 12);

    // Pick 2-4 random patterns to combine
    const patterns = [
      "arpeggio",
      "trill",
      "fanfare",
      "bounce",
      "stutter",
      "sweep",
    ];
    const numPatterns = this.randomInt(2, 4);
    const selectedPatterns = [];
    for (let i = 0; i < numPatterns; i++) {
      selectedPatterns.push(this.pick(patterns));
    }

    for (const pattern of selectedPatterns) {
      const patternVolume = volume * this.random(0.85, 1.0);

      if (pattern === "arpeggio") {
        // Ascending or descending major arpeggio
        const ascending = Math.random() > 0.3;
        const degrees = ascending ? [0, 2, 4, 7] : [7, 4, 2, 0];
        const reps = this.randomInt(1, 3);
        for (let r = 0; r < reps; r++) {
          for (const deg of degrees) {
            const freq = scaleFreq(deg) * (r > 0 ? 2 : 1);
            const dur = this.random(0.04, 0.08);
            this.playNote(
              freq,
              dur,
              time,
              patternVolume,
              "sine",
              this.random(-10, 20)
            );
            time += dur + this.random(0.01, 0.03);
          }
        }
      } else if (pattern === "trill") {
        // Rapid alternation between two notes
        const deg1 = this.randomInt(0, 4);
        const deg2 = deg1 + this.randomInt(1, 3);
        const trillCount = this.randomInt(4, 10);
        for (let i = 0; i < trillCount; i++) {
          const freq = scaleFreq(i % 2 === 0 ? deg1 : deg2);
          const dur = this.random(0.03, 0.05);
          this.playNote(freq, dur, time, patternVolume * 0.9, "sine", 0);
          time += dur;
        }
        time += 0.02;
      } else if (pattern === "fanfare") {
        // Triumphant ascending run
        const startDeg = this.randomInt(0, 2);
        const noteCount = this.randomInt(3, 6);
        for (let i = 0; i < noteCount; i++) {
          const freq = scaleFreq(startDeg + i);
          const dur =
            i === noteCount - 1
              ? this.random(0.12, 0.2)
              : this.random(0.05, 0.08);
          const bend =
            i === noteCount - 1 ? this.random(30, 80) : this.random(-5, 15);
          this.playNote(freq, dur, time, patternVolume, "sine", bend);
          time += dur * 0.8;
        }
        time += 0.05;
      } else if (pattern === "bounce") {
        // Bouncing between high and low with decreasing interval
        const highDeg = this.randomInt(5, 8);
        const lowDeg = this.randomInt(0, 2);
        const bounces = this.randomInt(3, 6);
        for (let i = 0; i < bounces; i++) {
          const freq = scaleFreq(i % 2 === 0 ? highDeg : lowDeg);
          const dur = 0.06 - i * 0.005;
          this.playNote(
            freq,
            Math.max(dur, 0.03),
            time,
            patternVolume,
            "sine",
            0
          );
          time += Math.max(dur, 0.03) + 0.01;
        }
      } else if (pattern === "stutter") {
        // Repeated same note getting faster
        const deg = this.randomInt(3, 7);
        const freq = scaleFreq(deg);
        const stutterCount = this.randomInt(3, 7);
        let gap = 0.08;
        for (let i = 0; i < stutterCount; i++) {
          this.playNote(freq, 0.04, time, patternVolume, "sine", 0);
          time += gap;
          gap *= 0.7; // Speed up
        }
        time += 0.03;
      } else if (pattern === "sweep") {
        // Smooth pitch sweep up or down
        const startDeg = Math.random() > 0.5 ? 0 : 7;
        const endDeg = startDeg === 0 ? 7 : 0;
        const startFreq = scaleFreq(startDeg);
        const endFreq = scaleFreq(endDeg);
        const dur = this.random(0.15, 0.25);
        this.playNote(
          startFreq,
          dur,
          time,
          patternVolume,
          "sine",
          endFreq - startFreq
        );
        time += dur + 0.02;
      }

      // Small gap between patterns
      time += this.random(0.02, 0.06);
    }

    // Finishing flourish - 50% chance of a final triumphant note
    if (Math.random() > 0.5) {
      const finishFreq = scaleFreq(this.randomInt(7, 9));
      this.playNote(
        finishFreq,
        0.18,
        time,
        volume,
        "sine",
        this.random(50, 120)
      );
      time += 0.2;
    }

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 150);
  }

  randomContent() {
    const expressions = ["content", "content", "content", "curious"];
    const expr = this.pick(expressions);
    this[expr]();
  }
}

/**
 * ModemVoice - Special voice for Modem character
 * Sounds like classic dial-up modem with handshake tones, carrier signals, and data bursts
 */
export class ModemVoice extends RobotVoice {
  constructor(character) {
    super(character);
  }

  // Override playNote to sometimes add modem-style harmonics
  _playModemTone(frequency, duration, delay = 0, volume = 0.05) {
    // Main tone
    this.playNote(frequency, duration, delay, volume, "sine", 0);
    // Add slight harmonic for that digital edge
    this.playNote(frequency * 2, duration, delay, volume * 0.15, "sine", 0);
  }

  _playDataBurst(startTime, duration, volume) {
    // Rapid frequency-shift keying simulation
    const burstCount = Math.floor(duration / 0.02);
    const freqs = [1200, 2400, 1800, 2100, 1500, 2700];

    for (let i = 0; i < burstCount; i++) {
      const freq = this.pick(freqs) + this.random(-50, 50);
      this.playNote(
        freq,
        0.015,
        startTime + i * 0.018,
        volume * 0.6,
        "square",
        0
      );
    }
  }

  _playCarrierTone(frequency, duration, delay, volume) {
    // Warbling carrier signal
    const osc = audioContext.createOscillator();
    const lfo = audioContext.createOscillator();
    const lfoGain = audioContext.createGain();
    const gain = audioContext.createGain();

    osc.type = "sine";
    lfo.type = "sine";
    lfo.frequency.value = this.random(15, 25);
    lfoGain.gain.value = this.random(20, 40);

    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(gain);
    gain.connect(this.panner);

    const startTime = audioContext.currentTime + delay;
    osc.frequency.setValueAtTime(this._freq(frequency), startTime);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(
      volume * getMasterVolume(),
      startTime + 0.02
    );
    gain.gain.setValueAtTime(
      volume * getMasterVolume(),
      startTime + duration - 0.02
    );
    gain.gain.linearRampToValueAtTime(0, startTime + duration);

    osc.start(startTime);
    lfo.start(startTime);
    osc.stop(startTime + duration + 0.01);
    lfo.stop(startTime + duration + 0.01);
  }

  content() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.15;

    // Soft carrier acknowledgment
    this._playCarrierTone(1200, 0.15, time, volume);
    time += 0.18;
    this._playCarrierTone(1000, 0.1, time, volume * 0.8);
    time += 0.15;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  excited() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.2;

    // Rapid handshake sequence
    const handshakeFreqs = [2100, 1200, 2400, 1800, 2700];
    for (let i = 0; i < this.randomInt(4, 7); i++) {
      const freq = this.pick(handshakeFreqs);
      this._playModemTone(freq, 0.06, time, volume);
      time += 0.07;
    }

    // Data burst celebration
    this._playDataBurst(time, this.random(0.2, 0.35), volume);
    time += 0.4;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  happy() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.22;

    // Connection success sequence
    this._playCarrierTone(2100, 0.2, time, volume);
    time += 0.22;
    this._playCarrierTone(1200, 0.15, time, volume);
    time += 0.18;

    // Celebratory ascending tones
    const successFreqs = [1200, 1500, 1800, 2100, 2400];
    for (const freq of successFreqs) {
      this.playNote(freq, 0.08, time, volume * 0.9, "sine", 30);
      time += 0.07;
    }

    // Happy data burst
    this._playDataBurst(time, 0.3, volume);
    time += 0.35;

    // Final success tone
    this._playCarrierTone(2400, 0.25, time, volume);
    time += 0.3;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 150);
  }

  sad() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.18;

    // Disconnection / no carrier sound
    this._playCarrierTone(2100, 0.3, time, volume);
    time += 0.35;

    // Descending failure tones
    const failFreqs = [1800, 1500, 1200, 900, 600];
    for (const freq of failFreqs) {
      this.playNote(freq, 0.12, time, volume * 0.7, "sine", -20);
      time += 0.15;
    }

    // Static/noise fade
    this._playCarrierTone(400, 0.4, time, volume * 0.5);
    time += 0.5;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 200);
  }

  angry() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.25;

    // Error/busy signal
    for (let i = 0; i < this.randomInt(3, 5); i++) {
      this.playNote(480, 0.15, time, volume, "square", 0);
      time += 0.2;
      this.playNote(620, 0.15, time, volume, "square", 0);
      time += 0.2;
    }

    // Harsh carrier screech
    this._playCarrierTone(2800, 0.3, time, volume);
    time += 0.35;

    // Aggressive data burst
    this._playDataBurst(time, 0.4, volume);
    time += 0.45;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  curious() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.18;

    // Probing carrier tone
    this._playCarrierTone(1200, 0.12, time, volume);
    time += 0.15;
    this._playCarrierTone(1800, 0.2, time, volume);
    time += 0.25;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  inquisitive() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.2;

    // Questioning handshake attempt
    const patterns = this.randomInt(1, 3);
    for (let p = 0; p < patterns; p++) {
      // Probing tones
      this._playCarrierTone(
        1200 + this.random(-100, 100),
        0.1,
        time,
        volume * 0.8
      );
      time += 0.12;

      // Rising query
      this.playNote(1500, 0.08, time, volume, "sine", 200);
      time += 0.12;

      // Short data probe
      this._playDataBurst(time, 0.1, volume * 0.7);
      time += 0.15;
    }

    // Final questioning carrier sweep (like "hello?")
    this.playNote(800, 0.12, time, volume * 0.7, "sine", 10);
    time += 0.15;
    this._playCarrierTone(1200, 0.5, time, volume);
    // Add rising pitch at end
    this.playNote(1200, 0.4, time + 0.1, volume * 0.8, "sine", 600);
    time += 0.55;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 150);
  }

  acknowledge() {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    let time = 0;
    const volume = 0.15;

    // Quick ACK tones
    this.playNote(2100, 0.05, time, volume, "sine", 0);
    time += 0.06;
    this.playNote(1200, 0.08, time, volume, "sine", 0);
    time += 0.1;

    setTimeout(() => {
      this.isSpeaking = false;
    }, time * 1000 + 100);
  }

  randomContent() {
    const expressions = ["content", "curious", "acknowledge", "inquisitive"];
    const weights = [0.3, 0.3, 0.2, 0.2];

    let r = Math.random();
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        this[expressions[i]]();
        return;
      }
    }
    this.content();
  }
}

/**
 * Factory function to create the appropriate voice type for a character
 */
export function createVoiceForCharacter(character) {
  if (!character) {
    return new RobotVoice();
  }

  if (character.voiceType === "modem") {
    return new ModemVoice(character);
  }

  return new RobotVoice(character);
}
