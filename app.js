/* ============================================================
   Workout Interval Timer — app.js
   Vanilla ES6+. Sin dependencias externas.

   Responsabilidades:
     Utils          – utilidades puras (tiempo, ids, clonado)
     StorageManager – persistencia en localStorage
     AudioManager   – señales sonoras con Web Audio API
     SpeechManager  – anuncios con speechSynthesis
     WakeLockManager– bloqueo de pantalla opcional
     WorkoutLogic   – lógica pura de secuencia / estimación
     SelfTests      – assertions de la lógica pura
     store          – estado + máquina de estados explícita
     TimerEngine    – bucle rAF basado en marcas de tiempo
     Session        – transiciones de la sesión
     UI             – render desacoplado del cálculo
     App            – wiring de la interfaz y arranque
   ============================================================ */
'use strict';

(function () {

  const $ = (sel, root = document) => root.querySelector(sel);

  /* ============================================================
     UTILS
     ============================================================ */
  const Utils = {
    uid() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    },
    clamp(n, min, max) {
      n = Number(n);
      if (!isFinite(n)) n = min;
      return Math.min(max, Math.max(min, n));
    },
    deepClone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },
    formatMs(ms) {
      ms = Math.max(0, Math.floor(ms));
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) {
        return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    },
    formatClock(ts) {
      if (!ts) return '—';
      try { return new Date(ts).toLocaleTimeString(); } catch (e) { return '—'; }
    },
    escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    },
    vibrate(pattern) {
      try {
        if (navigator.vibrate) navigator.vibrate(pattern);
      } catch (e) { /* sin soporte */ }
    }
  };

  /* ============================================================
     STORAGE MANAGER
     ============================================================ */
  const StorageManager = {
    KEYS: {
      last: 'wit.workout.last.v1',
      routines: 'wit.routines.v1',
      prefs: 'wit.prefs.v1'
    },
    read(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) { /* cuota / modo privado */ }
    },
    loadLast() { return this.read(this.KEYS.last, null); },
    saveLast(workout) { this.write(this.KEYS.last, workout); },
    loadPrefs() { return this.read(this.KEYS.prefs, { theme: 'dark' }); },
    savePrefs(prefs) { this.write(this.KEYS.prefs, prefs); },
    getRoutines() {
      const list = this.read(this.KEYS.routines, []);
      return Array.isArray(list) ? list : [];
    },
    saveRoutines(list) { this.write(this.KEYS.routines, list); }
  };

  /* ============================================================
     AUDIO MANAGER (Web Audio API, sin archivos)
     ============================================================ */
  const AudioManager = {
    ctx: null,
    enabled: true,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { this.ctx = new AC(); } catch (e) { return null; }
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    },
    unlock() { this.ensure(); },
    beep(opts) {
      if (!this.enabled) return;
      const o = Object.assign({ freq: 880, duration: 0.12, type: 'sine', gain: 0.18, when: 0, count: 1, gap: 0.2 }, opts);
      const ctx = this.ensure();
      if (!ctx) return;
      const start = ctx.currentTime + o.when;
      for (let i = 0; i < o.count; i++) {
        const t = start + i * o.gap;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = o.type;
        osc.frequency.setValueAtTime(o.freq, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(o.gain, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + o.duration);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + o.duration + 0.03);
      }
    },
    work() { this.beep({ freq: 880, duration: 0.16, type: 'square', gain: 0.16 }); },
    rest() { this.beep({ freq: 440, duration: 0.28, type: 'triangle', gain: 0.2 }); },
    tick() { this.beep({ freq: 1000, duration: 0.08, type: 'sine', gain: 0.14 }); },
    countdown() { this.beep({ freq: 660, duration: 0.1, type: 'sine', gain: 0.14 }); },
    finish() { this.beep({ freq: 660, duration: 0.22, type: 'sine', gain: 0.22, count: 3, gap: 0.3 }); }
  };

  /* ============================================================
     SPEECH MANAGER
     ============================================================ */
  const SpeechManager = {
    enabled: false,
    supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
    say(text) {
      if (!this.enabled || !this.supported || !text) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'es-ES';
        u.rate = 1;
        u.pitch = 1;
        window.speechSynthesis.speak(u);
      } catch (e) { /* ignorar */ }
    },
    cancel() {
      if (!this.supported) return;
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignorar */ }
    }
  };

  /* ============================================================
     WAKE LOCK MANAGER
     ============================================================ */
  const WakeLockManager = {
    sentinel: null,
    async request() {
      try {
        if (!('wakeLock' in navigator)) return;
        if (document.visibilityState !== 'visible') return;
        if (this.sentinel) return;
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => { this.sentinel = null; });
      } catch (e) { this.sentinel = null; }
    },
    async release() {
      try {
        if (this.sentinel) {
          await this.sentinel.release();
        }
      } catch (e) { /* ignorar */ }
      this.sentinel = null;
    }
  };

  /* ============================================================
     WORKOUT LOGIC (pura)
     ============================================================ */
  const WorkoutLogic = {
    /**
     * Genera la secuencia completa de segmentos hasta consumir
     * exactamente el tiempo activo objetivo.
     * El descanso NUNCA reduce el tiempo activo.
     * @returns Array<{type:'WORK'|'REST', exerciseIndex:number, round:number, durationMs:number}>
     */
    buildSequence(workout) {
      const segments = [];
      const exs = (workout && workout.exercises) ? workout.exercises : [];
      if (!exs.length || !(workout.activeTargetMs > 0)) return segments;

      let active = workout.activeTargetMs;
      let index = 0;
      let round = 1;
      let guard = 0;

      while (active > 0 && guard++ < 1000000) {
        const ex = exs[index];
        const durationMs = Math.min(ex.durationMs, active);
        if (durationMs <= 0) break;

        segments.push({ type: 'WORK', exerciseIndex: index, round, durationMs });
        active -= durationMs;

        if (active <= 0) break;

        index += 1;
        let wrapped = false;
        if (index >= exs.length) {
          if (!workout.repeatUntilGoal) break;
          index = 0;
          round += 1;
          wrapped = true;
        }

        if (workout.restMs > 0) {
          if (!wrapped || workout.restBetweenRounds) {
            segments.push({ type: 'REST', exerciseIndex: index, round, durationMs: workout.restMs });
          }
        }
      }
      return segments;
    },

    simulate(workout) {
      const segments = this.buildSequence(workout);
      let realMs = workout.initialCountdownMs || 0;
      let workTotalMs = 0;
      let transitions = 0;
      for (const seg of segments) {
        realMs += seg.durationMs;
        if (seg.type === 'WORK') workTotalMs += seg.durationMs;
        else transitions += 1;
      }
      const workSegments = segments.filter((s) => s.type === 'WORK');
      const rounds = workSegments.length ? workSegments[workSegments.length - 1].round : 0;
      return { realMs, workTotalMs, transitions, rounds, segments };
    }
  };

  /* ============================================================
     STATE MACHINE
     ============================================================ */
  const STATE = Object.freeze({
    CONFIG: 'CONFIG',
    READY: 'READY',
    COUNTDOWN: 'COUNTDOWN',
    WORK: 'WORK',
    REST: 'REST',
    PAUSED: 'PAUSED',
    FINISHED: 'FINISHED'
  });

  const RUNNING_PHASES = [STATE.COUNTDOWN, STATE.WORK, STATE.REST];
  const isRunningPhase = (p) => RUNNING_PHASES.indexOf(p) !== -1;

  const store = {
    workout: null,        // copia inmutable en ejecución
    phase: STATE.CONFIG,
    previousPhase: null,
    phaseElapsed: 0,      // ms consumidos de la fase actual
    phaseDuration: 0,     // ms que dura la fase actual
    activeSessionRemaining: 0,
    workActiveAtPhaseStart: 0,
    exerciseIndex: 0,
    round: 1,
    completedExercises: 0,
    skippedExercises: 0,
    restElapsed: 0,
    realElapsed: 0,
    cueSecond: null,
    sessionStartWall: 0,
    sessionEndWall: 0,
    summary: null,
    _wrapped: false,
    _quiet: false
  };

  /* ============================================================
     TIMER ENGINE (rAF + performance.now, sin drift)
     ============================================================ */
  const TimerEngine = {
    running: false,
    rafId: null,
    lastPerf: 0,
    onFrame: null,
    resetClock() { this.lastPerf = performance.now(); },
    start(onFrame) {
      this.onFrame = onFrame;
      if (this.running) return;
      this.running = true;
      this.lastPerf = performance.now();
      const loop = () => {
        if (!this.running) return;
        const now = performance.now();
        let dt = now - this.lastPerf;
        this.lastPerf = now;
        if (dt < 0) dt = 0;
        try { this.onFrame(dt); } catch (e) { console.error('[frame]', e); }
        this.rafId = window.requestAnimationFrame(loop);
      };
      this.rafId = window.requestAnimationFrame(loop);
    },
    stop() {
      this.running = false;
      if (this.rafId) window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    },
    forceTick() {
      if (!this.running || !this.onFrame) return;
      const now = performance.now();
      let dt = now - this.lastPerf;
      this.lastPerf = now;
      if (dt < 0) dt = 0;
      this.onFrame(dt);
    }
  };

  /* ============================================================
     SESSION ENGINE
     ============================================================ */
  const Session = {
    setPhase(phase) {
      store.phase = phase;
    },

    start(workout) {
      TimerEngine.stop();
      WakeLockManager.release();

      store.workout = Utils.deepClone(workout);
      store.previousPhase = null;
      store.activeSessionRemaining = workout.activeTargetMs;
      store.exerciseIndex = 0;
      store.round = 1;
      store.completedExercises = 0;
      store.skippedExercises = 0;
      store.restElapsed = 0;
      store.realElapsed = 0;
      store.cueSecond = null;
      store.phaseElapsed = 0;
      store.phaseDuration = 0;
      store.sessionStartWall = Date.now();
      store.sessionEndWall = 0;
      store.summary = null;
      store._wrapped = false;
      store._quiet = false;

      AudioManager.enabled = !!workout.soundOn;
      SpeechManager.enabled = !!workout.voiceOn;
      AudioManager.unlock();

      UI.showScreen('session');
      this.setPhase(STATE.READY);

      if (workout.initialCountdownMs > 0) {
        this.setPhase(STATE.COUNTDOWN);
        store.phaseElapsed = 0;
        store.phaseDuration = workout.initialCountdownMs;
        if (AudioManager.enabled) AudioManager.countdown();
        SpeechManager.say('Prepárate');
        UI.announce('Prepárate');
      } else {
        this.beginWork();
      }

      TimerEngine.resetClock();
      TimerEngine.start((dt) => Session.onFrame(dt));
      WakeLockManager.request();
      UI.render();
    },

    restart() {
      if (!store.workout) return;
      this.start(store.workout);
    },

    exit() {
      TimerEngine.stop();
      WakeLockManager.release();
      SpeechManager.cancel();
      this.setPhase(STATE.CONFIG);
      UI.showScreen('config');
    },

    onFrame(dt) {
      store._quiet = dt > 1500; // re-sincronización (pestaña oculta): evita ráfaga de sonidos
      if (isRunningPhase(store.phase)) {
        this.consume(dt);
      }
      store._quiet = false;
      UI.render();
    },

    /** Consume `dt` ms atravesando tantas fases como haga falta. */
    consume(dt) {
      let remaining = dt;
      let guard = 0;
      while (remaining > 1e-6 && guard++ < 100000) {
        if (!isRunningPhase(store.phase)) break;

        const left = store.phaseDuration - store.phaseElapsed;
        if (left <= 1e-6) {
          this.completePhase();
          continue;
        }

        const consume = Math.min(remaining, left);
        store.phaseElapsed += consume;
        store.realElapsed += consume;
        if (store.phase === STATE.REST) store.restElapsed += consume;
        remaining -= consume;

        if (store.phaseElapsed >= store.phaseDuration - 1e-6) {
          this.completePhase();
        }
      }
      this.checkCues();
    },

    checkCues() {
      if (store.phase !== STATE.WORK) return;
      const remainingMs = Math.max(0, store.phaseDuration - store.phaseElapsed);
      const sec = Math.ceil(remainingMs / 1000);
      if (remainingMs > 0 && sec >= 1 && sec <= 3 && sec !== store.cueSecond) {
        store.cueSecond = sec;
        if (!store._quiet && AudioManager.enabled) AudioManager.tick();
      }
    },

    completePhase() {
      switch (store.phase) {
        case STATE.COUNTDOWN:
        case STATE.REST:
        case STATE.READY:
          this.beginWork();
          break;
        case STATE.WORK:
          this.onWorkComplete();
          break;
        default:
          break;
      }
    },

    onWorkComplete() {
      // El trabajo consumido es exactamente la duración de la fase (posiblemente truncada).
      store.activeSessionRemaining = Math.max(0, store.activeSessionRemaining - store.phaseDuration);
      store.completedExercises += 1;

      if (store.activeSessionRemaining <= 0) {
        this.finish();
        return;
      }

      const advanced = this.advancePointer();
      if (!advanced) {
        this.finish();
        return;
      }

      if (this.shouldRestBeforeNext()) this.beginRest();
      else this.beginWork();
    },

    advancePointer() {
      const exs = store.workout.exercises;
      if (store.exerciseIndex + 1 < exs.length) {
        store.exerciseIndex += 1;
        store._wrapped = false;
        return true;
      }
      if (store.workout.repeatUntilGoal) {
        store.exerciseIndex = 0;
        store.round += 1;
        store._wrapped = true;
        return true;
      }
      return false;
    },

    shouldRestBeforeNext() {
      if (store.workout.restMs <= 0) return false;
      if (store._wrapped && !store.workout.restBetweenRounds) return false;
      return true;
    },

    beginRest() {
      this.setPhase(STATE.REST);
      store.phaseElapsed = 0;
      store.phaseDuration = store.workout.restMs;
      if (!store._quiet) {
        if (AudioManager.enabled) AudioManager.rest();
        SpeechManager.say('Descanso');
        Utils.vibrate(80);
      }
      UI.announce('Descanso');
    },

    beginWork() {
      const exs = store.workout.exercises;
      store._wrapped = false;

      const ex = exs[store.exerciseIndex];
      if (!ex) { this.finish(); return; }

      let duration = ex.durationMs;
      if (duration > store.activeSessionRemaining) duration = store.activeSessionRemaining;
      if (duration <= 0) { this.finish(); return; }

      this.setPhase(STATE.WORK);
      store.phaseElapsed = 0;
      store.phaseDuration = duration;
      store.workActiveAtPhaseStart = store.activeSessionRemaining;
      store.cueSecond = null;

      if (!store._quiet) {
        if (AudioManager.enabled) AudioManager.work();
        SpeechManager.say(ex.name);
        Utils.vibrate(60);
      }
      UI.announce('Ejercicio ' + (store.exerciseIndex + 1) + ' de ' + exs.length + ': ' + ex.name);
    },

    skip() {
      const phase = store.phase;
      if (phase === STATE.PAUSED) return;

      if (phase === STATE.COUNTDOWN) { this.beginWork(); return; }
      if (phase === STATE.REST) { this.beginWork(); return; }
      if (phase !== STATE.WORK) return;

      // El tiempo no ejecutado NO se descuenta del tiempo activo,
      // pero el tiempo ya trabajado del ejercicio actual SÍ queda consumido.
      store.activeSessionRemaining = Math.max(0, store.activeSessionRemaining - store.phaseElapsed);
      store.skippedExercises += 1;
      const advanced = this.advancePointer();
      if (!advanced) { this.finish(); return; }
      if (this.shouldRestBeforeNext()) this.beginRest();
      else this.beginWork();
    },

    previous() {
      const phase = store.phase;
      if (phase === STATE.PAUSED) return;
      if (phase !== STATE.WORK && phase !== STATE.REST && phase !== STATE.COUNTDOWN) return;

      // El tiempo parcial del ejercicio actual se descarta (no se cuenta como trabajado)
      // y permanece disponible en el tiempo activo general.
      const exs = store.workout.exercises;
      if (store.exerciseIndex > 0) {
        store.exerciseIndex -= 1;
      } else if (store.round > 1) {
        store.round -= 1;
        store.exerciseIndex = exs.length - 1;
      } else {
        store.exerciseIndex = 0;
      }
      this.beginWork();
    },

    togglePause() {
      if (store.phase === STATE.PAUSED) this.resume();
      else this.pause();
    },

    pause() {
      if (!isRunningPhase(store.phase)) return;
      store.previousPhase = store.phase;
      this.setPhase(STATE.PAUSED);
      SpeechManager.say('Pausado');
      UI.announce('Pausado');
    },

    resume() {
      if (store.phase !== STATE.PAUSED) return;
      this.setPhase(store.previousPhase || STATE.WORK);
      SpeechManager.say('Reanudado');
      UI.announce('Reanudado');
    },

    finish() {
      if (store.phase === STATE.FINISHED) return;
      this.setPhase(STATE.FINISHED);
      store.sessionEndWall = Date.now();
      TimerEngine.stop();
      WakeLockManager.release();

      store.summary = {
        targetMs: store.workout.activeTargetMs,
        completedActiveMs: Math.max(0, store.workout.activeTargetMs - store.activeSessionRemaining),
        realMs: store.realElapsed,
        restMs: store.restElapsed,
        completedExercises: store.completedExercises,
        skippedExercises: store.skippedExercises,
        rounds: store.round,
        startWall: store.sessionStartWall,
        endWall: store.sessionEndWall
      };

      if (AudioManager.enabled) AudioManager.finish();
      SpeechManager.say('Entrenamiento completado');
      Utils.vibrate([120, 80, 120, 80, 200]);
      UI.announce('Entrenamiento completado');
      UI.renderSummary(store.summary);
      UI.showScreen('summary');
    }
  };

  /* ============================================================
     UI
     ============================================================ */
  const UI = {
    screens: {},

    showScreen(name) {
      ['config', 'session', 'summary'].forEach((key) => {
        const el = $('#screen-' + key);
        if (el) el.hidden = (key !== name);
      });
      document.body.classList.toggle('in-session', name === 'session');
    },

    announce(text) {
      const el = $('#sr-announcer');
      if (!el) return;
      el.textContent = '';
      el.textContent = text;
    },

    render() {
      const w = store.workout;
      if (!w) return;
      const exs = w.exercises;

      const phase = store.phase;
      const displayPhase = phase === STATE.PAUSED ? (store.previousPhase || STATE.WORK) : phase;

      // ---- barra de estado ----
      let statusText = 'LISTO';
      let statusIcon = '\u25CF';
      switch (phase) {
        case STATE.COUNTDOWN: statusText = 'PREP\u00C1RATE'; statusIcon = '\u23F3'; break;
        case STATE.WORK: statusText = 'ENTRENANDO'; statusIcon = '\u{1F3C3}'; break;
        case STATE.REST: statusText = 'DESCANSO'; statusIcon = '\u{1F9D8}'; break;
        case STATE.PAUSED: statusText = 'PAUSADO'; statusIcon = '\u23F8'; break;
        case STATE.FINISHED: statusText = 'COMPLETADO'; statusIcon = '\u2705'; break;
        default: break;
      }
      const bar = $('#status-bar');
      bar.dataset.state = phase;
      $('#status-text').textContent = statusText;
      $('#status-icon').textContent = statusIcon;

      // ---- tiempo principal ----
      const remaining = Math.max(0, store.phaseDuration - store.phaseElapsed);
      const primary = (displayPhase === STATE.FINISHED) ? 0 : remaining;
      $('#primary-display').textContent = Utils.formatMs(primary);

      // ---- badge de descanso ----
      const badge = $('#phase-badge');
      if (displayPhase === STATE.REST) {
        badge.hidden = false;
        badge.textContent = 'DESCANSO';
      } else {
        badge.hidden = true;
      }

      // ---- etiqueta principal / ejercicio ----
      const currentEx = exs[store.exerciseIndex] || null;
      let label = '';
      if (displayPhase === STATE.COUNTDOWN) label = currentEx ? currentEx.name : 'Prep\u00E1rate';
      else if (displayPhase === STATE.REST) label = 'Recupera y respira';
      else if (displayPhase === STATE.WORK || displayPhase === STATE.PAUSED) label = currentEx ? currentEx.name : '';
      else if (displayPhase === STATE.FINISHED) label = 'Sesi\u00F3n finalizada';
      $('#main-label').textContent = label;

      // ---- meta ----
      const metaIndex = Utils.clamp(store.exerciseIndex + 1, 1, exs.length);
      $('#meta-exercise').textContent = 'Ejercicio ' + metaIndex + ' de ' + exs.length;
      $('#meta-round').textContent = 'Vuelta ' + store.round;

      // ---- siguiente ----
      const nextEl = $('#next-exercise');
      if (displayPhase === STATE.REST || displayPhase === STATE.COUNTDOWN) {
        const upcoming = exs[store.exerciseIndex] || null;
        nextEl.textContent = upcoming ? 'Siguiente: ' + upcoming.name : 'Siguiente: \u2014';
      } else if (displayPhase === STATE.FINISHED) {
        nextEl.textContent = 'Sesi\u00F3n completada';
      } else {
        let ni = store.exerciseIndex + 1;
        if (ni >= exs.length) ni = w.repeatUntilGoal ? 0 : -1;
        nextEl.textContent = ni >= 0 ? 'Siguiente: ' + exs[ni].name : 'Siguiente: \u00DAltimo ejercicio';
      }

      // ---- tiempo activo restante (congelado en REST / PAUSED) ----
      const activeDisplay = (displayPhase === STATE.WORK)
        ? Math.max(0, store.activeSessionRemaining - store.phaseElapsed)
        : store.activeSessionRemaining;
      $('#active-remaining').textContent = Utils.formatMs(activeDisplay);

      // ---- barras de progreso ----
      const exLabel = $('#progress-exercise-label');
      const exBar = $('#bar-exercise');
      let exProgress = 0;
      if (displayPhase === STATE.WORK) {
        exLabel.textContent = 'Ejercicio';
        exProgress = store.phaseDuration > 0 ? store.phaseElapsed / store.phaseDuration : 0;
      } else if (displayPhase === STATE.REST) {
        exLabel.textContent = 'Descanso';
        exProgress = store.phaseDuration > 0 ? store.phaseElapsed / store.phaseDuration : 0;
      } else if (displayPhase === STATE.COUNTDOWN) {
        exLabel.textContent = 'Cuenta';
        exProgress = store.phaseDuration > 0 ? store.phaseElapsed / store.phaseDuration : 0;
      }
      exProgress = Utils.clamp(exProgress, 0, 1);
      exBar.style.width = (exProgress * 100).toFixed(1) + '%';
      $('#progress-exercise').setAttribute('aria-valuenow', Math.round(exProgress * 100));

      const sessionProgress = w.activeTargetMs > 0
        ? Utils.clamp((w.activeTargetMs - activeDisplay) / w.activeTargetMs, 0, 1)
        : 0;
      $('#bar-session').style.width = (sessionProgress * 100).toFixed(1) + '%';
      $('#progress-session').setAttribute('aria-valuenow', Math.round(sessionProgress * 100));

      // ---- controles ----
      const paused = phase === STATE.PAUSED;
      const pauseBtn = $('#btn-pause');
      pauseBtn.textContent = paused ? 'Reanudar' : 'Pausar';
      pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    },

    renderSummary(summary) {
      const rows = [
        ['Tiempo activo objetivo', Utils.formatMs(summary.targetMs), false],
        ['Tiempo activo completado', Utils.formatMs(summary.completedActiveMs), true],
        ['Duraci\u00F3n real total', Utils.formatMs(summary.realMs), false],
        ['Tiempo en descansos', Utils.formatMs(summary.restMs), false],
        ['Ejercicios completados', String(summary.completedExercises), false],
        ['Ejercicios saltados', String(summary.skippedExercises), false],
        ['Vueltas completadas', String(summary.rounds), false],
        ['Hora de inicio', Utils.formatClock(summary.startWall), false],
        ['Hora de finalizaci\u00F3n', Utils.formatClock(summary.endWall), false]
      ];
      $('#summary-grid').innerHTML = rows.map((r) => (
        '<div class="summary-item' + (r[2] ? ' highlight' : '') + '">' +
          '<dt>' + Utils.escapeHtml(r[0]) + '</dt>' +
          '<dd>' + Utils.escapeHtml(r[1]) + '</dd>' +
        '</div>'
      )).join('');
    }
  };

  /* ============================================================
     SELF TESTS (lógica pura)
     ============================================================ */
  const SelfTests = {
    run() {
      const results = [];
      const test = (name, cond) => results.push({ name, pass: !!cond });

      const fiveEx = (dur) => Array.from({ length: 5 }, (_, i) => ({ id: 'e' + i, name: 'E' + i, durationMs: dur }));

      // Caso 1 — 30:00 activo, 5x30s, descanso 5s, repetir
      const c1 = {
        initialCountdownMs: 3000, restMs: 5000, repeatUntilGoal: true, restBetweenRounds: true,
        activeTargetMs: 1800000, exercises: fiveEx(30000)
      };
      const s1 = WorkoutLogic.simulate(c1);
      test('Caso1: trabajo activo exacto 1800000ms', s1.workTotalMs === 1800000);
      test('Caso1: 59 transiciones', s1.transitions === 59);
      test('Caso1: duracion real = activo + 59*5s + 3s', s1.realMs === 1800000 + 59 * 5000 + 3000);
      test('Caso1: descansos suman y NO tocan el activo', s1.realMs - s1.workTotalMs === 59 * 5000 + 3000);

      // Caso 2 — 2:00 activo, 3x45s, descanso 5s => ultimo truncado a 30s
      const c2 = {
        initialCountdownMs: 3000, restMs: 5000, repeatUntilGoal: true, restBetweenRounds: true,
        activeTargetMs: 120000,
        exercises: [
          { id: '1', name: 'A', durationMs: 45000 },
          { id: '2', name: 'B', durationMs: 45000 },
          { id: '3', name: 'C', durationMs: 45000 }
        ]
      };
      const s2 = WorkoutLogic.simulate(c2);
      const works2 = s2.segments.filter((x) => x.type === 'WORK');
      test('Caso2: trabajo total 120000ms', s2.workTotalMs === 120000);
      test('Caso2: ultimo ejercicio truncado a 30000ms', works2[works2.length - 1].durationMs === 30000);
      test('Caso2: 2 transiciones', s2.transitions === 2);

      // Caso 3 — descanso 0 => sin transiciones
      const s3 = WorkoutLogic.simulate(Object.assign({}, c2, { restMs: 0 }));
      test('Caso3: descanso 0 => 0 transiciones', s3.transitions === 0);
      test('Caso3: trabajo total 120000ms', s3.workTotalMs === 120000);

      // Caso 8 — activo menor que el primer ejercicio => truncado
      const s8 = WorkoutLogic.simulate({
        initialCountdownMs: 0, restMs: 5000, repeatUntilGoal: true, restBetweenRounds: true,
        activeTargetMs: 20000,
        exercises: [{ id: 'x', name: 'A', durationMs: 30000 }, { id: 'y', name: 'B', durationMs: 30000 }]
      });
      test('Caso8: primer ejercicio truncado a 20000ms', s8.segments[0].durationMs === 20000);
      test('Caso8: un unico segmento', s8.segments.length === 1);

      // Modo una sola vuelta
      const sOnce = WorkoutLogic.simulate(Object.assign({}, c1, { repeatUntilGoal: false }));
      test('Una vuelta: 5 trabajos', sOnce.segments.filter((x) => x.type === 'WORK').length === 5);
      test('Una vuelta: trabajo total 150000ms', sOnce.workTotalMs === 150000);
      test('Una vuelta: sin descanso final', sOnce.segments[sOnce.segments.length - 1].type === 'WORK');

      const failures = results.filter((r) => !r.pass);
      try {
        console.groupCollapsed('[SelfTests] ' + (results.length - failures.length) + '/' + results.length + ' OK');
        results.forEach((r) => console.log((r.pass ? '\u2713' : '\u2717') + ' ' + r.name));
        console.groupEnd();
      } catch (e) { /* entornos sin console */ }

      if (failures.length) {
        console.error('[SelfTests] Fallos:', failures);
      }
      return results;
    }
  };

  /* ============================================================
     APP CONTROLLER
     ============================================================ */
  const App = {
    draft: null,

    createDefaultWorkout() {
      const names = ['Sentadillas', 'Flexiones', 'Plancha', 'Jumping Jacks', 'Abdominales'];
      return {
        name: 'Mi entrenamiento',
        activeTargetMs: 30 * 60 * 1000,
        restMs: 5000,
        initialCountdownMs: 3000,
        repeatUntilGoal: true,
        restBetweenRounds: true,
        soundOn: true,
        voiceOn: false,
        exercises: names.map((n, i) => ({ id: Utils.uid(), name: n, durationMs: 30000 }))
      };
    },

    normalizeWorkout(w) {
      const def = this.createDefaultWorkout();
      if (!w || typeof w !== 'object') return def;

      const out = {
        name: (typeof w.name === 'string' && w.name.trim()) ? w.name.trim() : def.name,
        activeTargetMs: Number(w.activeTargetMs) > 0 ? Number(w.activeTargetMs) : def.activeTargetMs,
        restMs: Utils.clamp(Number(w.restMs) || 0, 0, 300000),
        initialCountdownMs: [0, 3000, 5000, 10000].indexOf(Number(w.initialCountdownMs)) !== -1
          ? Number(w.initialCountdownMs) : def.initialCountdownMs,
        repeatUntilGoal: w.repeatUntilGoal !== false,
        restBetweenRounds: w.restBetweenRounds !== false,
        soundOn: w.soundOn !== false,
        voiceOn: w.voiceOn === true,
        exercises: []
      };

      const arr = Array.isArray(w.exercises) ? w.exercises.slice(0, 50) : [];
      arr.forEach((ex, i) => {
        const name = (ex && typeof ex.name === 'string' && ex.name.trim()) ? ex.name.trim() : 'Ejercicio ' + (i + 1);
        const durationMs = Utils.clamp(Math.round(Number(ex && ex.durationMs) || 30000), 1000, 3600000);
        const id = (ex && typeof ex.id === 'string' && ex.id) ? ex.id : Utils.uid();
        out.exercises.push({ id, name, durationMs });
      });

      if (!out.exercises.length) out.exercises = def.exercises;
      return out;
    },

    syncScalars() {
      const d = this.draft;
      d.name = (($('#workout-name').value || '').trim()) || 'Mi entrenamiento';
      const h = Utils.clamp(parseInt($('#active-h').value, 10) || 0, 0, 99);
      const m = Utils.clamp(parseInt($('#active-m').value, 10) || 0, 0, 59);
      const s = Utils.clamp(parseInt($('#active-s').value, 10) || 0, 0, 59);
      d.activeTargetMs = (h * 3600 + m * 60 + s) * 1000;
      d.restMs = Utils.clamp(parseInt($('#rest-s').value, 10) || 0, 0, 300) * 1000;
      const cd = parseInt($('#countdown').value, 10);
      d.initialCountdownMs = [0, 3000, 5000, 10000].indexOf(cd) !== -1 ? cd : 3000;
      d.repeatUntilGoal = $('#repeat-mode').value === 'repeat';
      d.restBetweenRounds = $('#rest-between-rounds').checked;
    },

    fillForm() {
      const d = this.draft;
      $('#workout-name').value = d.name;
      const totalSec = Math.round(d.activeTargetMs / 1000);
      $('#active-h').value = Math.floor(totalSec / 3600);
      $('#active-m').value = Math.floor((totalSec % 3600) / 60);
      $('#active-s').value = totalSec % 60;
      $('#rest-s').value = Math.round(d.restMs / 1000);
      $('#countdown').value = String(d.initialCountdownMs);
      $('#repeat-mode').value = d.repeatUntilGoal ? 'repeat' : 'once';
      $('#rest-between-rounds').checked = d.restBetweenRounds;
      this.updateChips();
    },

    updateChips() {
      const s = $('#toggle-sound');
      const v = $('#toggle-voice');
      s.setAttribute('aria-pressed', this.draft.soundOn ? 'true' : 'false');
      v.setAttribute('aria-pressed', this.draft.voiceOn ? 'true' : 'false');
      s.disabled = !(window.AudioContext || window.webkitAudioContext);
      v.disabled = !SpeechManager.supported;
      if (v.disabled) v.setAttribute('title', 'Voz no disponible en este navegador');
    },

    saveLast() {
      StorageManager.saveLast(this.draft);
    },

    renderCalculator() {
      this.syncScalars();
      const d = this.draft;
      const sim = WorkoutLogic.simulate(d);
      const rows = [
        ['Tiempo activo objetivo', Utils.formatMs(d.activeTargetMs)],
        ['Descanso entre ejercicios', Utils.formatMs(d.restMs)],
        ['Ejercicios', String(d.exercises.length)],
        ['Modo', d.repeatUntilGoal ? 'Repetir hasta completar' : 'Una sola vuelta'],
        ['Cuenta regresiva inicial', Utils.formatMs(d.initialCountdownMs)],
        ['Transiciones estimadas', String(sim.transitions)]
      ];
      const html = rows.map((r) => (
        '<div><dt>' + Utils.escapeHtml(r[0]) + '</dt><dd>' + Utils.escapeHtml(r[1]) + '</dd></div>'
      )).join('') +
        '<div class="calc-total"><dt>Duraci\u00F3n real estimada</dt><dd>' + Utils.formatMs(sim.realMs) + '</dd></div>';
      $('#calc-summary').innerHTML = html;
    },

    renderExercises() {
      const list = $('#exercises-list');
      const d = this.draft;
      list.innerHTML = d.exercises.map((ex, i) => (
        '<li class="exercise-row" data-id="' + Utils.escapeHtml(ex.id) + '">' +
          '<span class="exercise-index" aria-hidden="true">' + (i + 1) + '</span>' +
          '<input class="ex-name" type="text" maxlength="60" value="' + Utils.escapeHtml(ex.name) + '" ' +
            'aria-label="Nombre del ejercicio ' + (i + 1) + '" />' +
          '<input class="ex-duration" type="number" min="1" max="3600" step="1" inputmode="numeric" ' +
            'value="' + Math.max(1, Math.round(ex.durationMs / 1000)) + '" ' +
            'aria-label="Duraci\u00F3n en segundos del ejercicio ' + (i + 1) + '" />' +
          '<div class="exercise-row-actions">' +
            '<button type="button" data-act="up" aria-label="Subir ejercicio ' + (i + 1) + '">\u2191</button>' +
            '<button type="button" data-act="down" aria-label="Bajar ejercicio ' + (i + 1) + '">\u2193</button>' +
            '<button type="button" data-act="dup" aria-label="Duplicar ejercicio ' + (i + 1) + '">\u29C9</button>' +
            '<button type="button" data-act="del" aria-label="Eliminar ejercicio ' + (i + 1) + '">\u2715</button>' +
          '</div>' +
        '</li>'
      )).join('');
      $('#exercise-count').textContent = d.exercises.length;
      this.updateExerciseNav();
    },

    updateExerciseNav() {
      const rows = document.querySelectorAll('.exercise-row');
      const last = rows.length - 1;
      rows.forEach((row, i) => {
        const up = row.querySelector('[data-act="up"]');
        const down = row.querySelector('[data-act="down"]');
        const del = row.querySelector('[data-act="del"]');
        up.disabled = i === 0;
        down.disabled = i === last;
        del.disabled = rows.length <= 1;
      });
    },

    renderRoutines() {
      const sel = $('#routines-select');
      const list = StorageManager.getRoutines();
      if (!list.length) {
        sel.innerHTML = '<option value="">(No hay rutinas guardadas)</option>';
      } else {
        sel.innerHTML = list.map((r, i) => (
          '<option value="' + i + '">' + Utils.escapeHtml(r.name || ('Rutina ' + (i + 1))) + '</option>'
        )).join('');
      }
    },

    loadIntoForm(workout) {
      this.draft = this.normalizeWorkout(workout);
      this.fillForm();
      this.renderExercises();
      this.renderCalculator();
    },

    applyPreset(name) {
      let w;
      if (name === 'tabata') {
        w = {
          name: 'Tabata', activeTargetMs: 160000, restMs: 10000, initialCountdownMs: 5000,
          repeatUntilGoal: true, restBetweenRounds: true, soundOn: this.draft.soundOn, voiceOn: this.draft.voiceOn,
          exercises: [{ id: Utils.uid(), name: 'Tabata 20s', durationMs: 20000 }]
        };
      } else if (name === 'movilidad') {
        w = {
          name: 'Movilidad', activeTargetMs: 600000, restMs: 10000, initialCountdownMs: 5000,
          repeatUntilGoal: true, restBetweenRounds: true, soundOn: this.draft.soundOn, voiceOn: this.draft.voiceOn,
          exercises: [
            { id: Utils.uid(), name: 'Gato-camello', durationMs: 40000 },
            { id: Utils.uid(), name: 'Estiramiento isquios', durationMs: 40000 },
            { id: Utils.uid(), name: 'Movilidad cadera', durationMs: 40000 },
            { id: Utils.uid(), name: 'Rotación torácica', durationMs: 40000 },
            { id: Utils.uid(), name: 'Postura del niño', durationMs: 40000 }
          ]
        };
      } else {
        w = {
          name: 'HIIT', activeTargetMs: 1200000, restMs: 15000, initialCountdownMs: 5000,
          repeatUntilGoal: true, restBetweenRounds: true, soundOn: this.draft.soundOn, voiceOn: this.draft.voiceOn,
          exercises: [
            { id: Utils.uid(), name: 'Burpees', durationMs: 30000 },
            { id: Utils.uid(), name: 'Sentadillas con salto', durationMs: 30000 },
            { id: Utils.uid(), name: 'Mountain climbers', durationMs: 30000 },
            { id: Utils.uid(), name: 'Escaladores cruzados', durationMs: 30000 },
            { id: Utils.uid(), name: 'Zancadas alternas', durationMs: 30000 },
            { id: Utils.uid(), name: 'Salto de cuerda', durationMs: 30000 }
          ]
        };
      }
      this.loadIntoForm(w);
      this.saveLast();
    },

    exportJson() {
      this.syncScalars();
      const data = JSON.stringify(this.draft, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (this.draft.name || 'rutina').replace(/[^\w\-]+/g, '_') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    importJson(file) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          this.loadIntoForm(parsed);
          this.saveLast();
        } catch (e) {
          alert('El archivo JSON no es v\u00E1lido.');
        }
      };
      reader.readAsText(file);
    }
  };

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  function bindEvents() {
    const form = $('#form-config');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      App.syncScalars();
      if (App.draft.activeTargetMs < 1000) {
        alert('Define al menos 1 segundo de tiempo activo.');
        return;
      }
      if (!App.draft.exercises.length) {
        alert('A\u00F1ade al menos un ejercicio.');
        return;
      }
      App.draft.exercises.forEach((ex, i) => {
        if (!ex.name || !ex.name.trim()) ex.name = 'Ejercicio ' + (i + 1);
        ex.durationMs = Utils.clamp(Math.round(ex.durationMs) || 30000, 1000, 3600000);
      });
      App.saveLast();
      Session.start(Utils.deepClone(App.draft));
    });

    // cambios escalares
    form.addEventListener('input', () => { App.renderCalculator(); });
    form.addEventListener('change', () => { App.renderCalculator(); App.saveLast(); });

    // ejercicios: edición incremental sin re-render (mantiene el foco)
    const exList = $('#exercises-list');
    exList.addEventListener('input', (e) => {
      const row = e.target.closest('.exercise-row');
      if (!row) return;
      const ex = App.draft.exercises.find((x) => x.id === row.dataset.id);
      if (!ex) return;
      if (e.target.classList.contains('ex-name')) {
        ex.name = e.target.value;
      } else if (e.target.classList.contains('ex-duration')) {
        const sec = Utils.clamp(parseInt(e.target.value, 10) || 1, 1, 3600);
        ex.durationMs = sec * 1000;
      }
      App.renderCalculator();
    });
    exList.addEventListener('change', () => { App.saveLast(); });

    exList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.exercise-row');
      const idx = App.draft.exercises.findIndex((x) => x.id === row.dataset.id);
      if (idx < 0) return;
      const act = btn.dataset.act;
      const exs = App.draft.exercises;

      if (act === 'del') {
        if (exs.length <= 1) return;
        exs.splice(idx, 1);
        App.renderExercises();
      } else if (act === 'up' && idx > 0) {
        const tmp = exs[idx - 1]; exs[idx - 1] = exs[idx]; exs[idx] = tmp;
        App.renderExercises();
      } else if (act === 'down' && idx < exs.length - 1) {
        const tmp = exs[idx + 1]; exs[idx + 1] = exs[idx]; exs[idx] = tmp;
        App.renderExercises();
      } else if (act === 'dup') {
        if (exs.length >= 50) return;
        const copy = {
          id: Utils.uid(),
          name: exs[idx].name + ' (copia)',
          durationMs: exs[idx].durationMs
        };
        exs.splice(idx + 1, 0, copy);
        App.renderExercises();
      }
      App.renderCalculator();
      App.saveLast();
    });

    $('#btn-add-exercise').addEventListener('click', () => {
      if (App.draft.exercises.length >= 50) return;
      App.draft.exercises.push({ id: Utils.uid(), name: 'Ejercicio ' + (App.draft.exercises.length + 1), durationMs: 30000 });
      App.renderExercises();
      App.renderCalculator();
      App.saveLast();
    });

    $('#btn-reset-exercises').addEventListener('click', () => {
      App.draft.exercises = App.createDefaultWorkout().exercises;
      App.renderExercises();
      App.renderCalculator();
      App.saveLast();
    });

    // toggles
    $('#toggle-sound').addEventListener('click', () => {
      App.draft.soundOn = !App.draft.soundOn;
      AudioManager.enabled = App.draft.soundOn;
      App.updateChips();
      if (App.draft.soundOn) { AudioManager.unlock(); AudioManager.work(); }
      App.saveLast();
    });

    $('#toggle-voice').addEventListener('click', () => {
      App.draft.voiceOn = !App.draft.voiceOn;
      SpeechManager.enabled = App.draft.voiceOn;
      App.updateChips();
      if (App.draft.voiceOn) SpeechManager.say('Voz activada');
      App.saveLast();
    });

    $('#toggle-theme').addEventListener('click', () => {
      const light = !document.body.classList.contains('light');
      document.body.classList.toggle('light', light);
      $('#toggle-theme').setAttribute('aria-pressed', light ? 'true' : 'false');
      const prefs = StorageManager.loadPrefs();
      prefs.theme = light ? 'light' : 'dark';
      StorageManager.savePrefs(prefs);
    });

    // controles de sesión
    $('#btn-pause').addEventListener('click', () => Session.togglePause());
    $('#btn-skip').addEventListener('click', () => Session.skip());
    $('#btn-prev').addEventListener('click', () => Session.previous());
    $('#btn-reset').addEventListener('click', () => Session.restart());
    $('#btn-exit').addEventListener('click', () => Session.exit());
    $('#btn-fullscreen').addEventListener('click', toggleFullscreen);

    // resumen
    $('#btn-repeat').addEventListener('click', () => { if (store.workout) Session.start(store.workout); });
    $('#btn-edit').addEventListener('click', () => Session.exit());
    $('#btn-new').addEventListener('click', () => {
      App.loadIntoForm(App.createDefaultWorkout());
      App.saveLast();
      Session.exit();
    });

    // rutinas
    $('#btn-save-routine').addEventListener('click', () => {
      App.syncScalars();
      const name = (prompt('Nombre de la rutina:', App.draft.name) || '').trim();
      if (!name) return;
      const list = StorageManager.getRoutines();
      const existing = list.findIndex((r) => r.name === name);
      const entry = { name, workout: Utils.deepClone(App.draft) };
      if (existing >= 0) list[existing] = entry; else list.push(entry);
      StorageManager.saveRoutines(list);
      App.renderRoutines();
    });

    $('#btn-load-routine').addEventListener('click', () => {
      const idx = parseInt($('#routines-select').value, 10);
      const list = StorageManager.getRoutines();
      if (isNaN(idx) || !list[idx]) { alert('Selecciona una rutina.'); return; }
      App.loadIntoForm(list[idx].workout);
      App.saveLast();
    });

    $('#btn-rename-routine').addEventListener('click', () => {
      const idx = parseInt($('#routines-select').value, 10);
      const list = StorageManager.getRoutines();
      if (isNaN(idx) || !list[idx]) { alert('Selecciona una rutina.'); return; }
      const name = (prompt('Nuevo nombre:', list[idx].name) || '').trim();
      if (!name) return;
      list[idx].name = name;
      StorageManager.saveRoutines(list);
      App.renderRoutines();
    });

    $('#btn-delete-routine').addEventListener('click', () => {
      const idx = parseInt($('#routines-select').value, 10);
      const list = StorageManager.getRoutines();
      if (isNaN(idx) || !list[idx]) { alert('Selecciona una rutina.'); return; }
      if (!confirm('¿Eliminar la rutina "' + list[idx].name + '"?')) return;
      list.splice(idx, 1);
      StorageManager.saveRoutines(list);
      App.renderRoutines();
    });

    $('#btn-export').addEventListener('click', () => App.exportJson());
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) App.importJson(file);
      e.target.value = '';
    });

    document.querySelectorAll('.preset').forEach((btn) => {
      btn.addEventListener('click', () => App.applyPreset(btn.dataset.preset));
    });

    // teclado: espacio = pausa/reanudar durante la sesión
    document.addEventListener('keydown', (e) => {
      if ($('#screen-session').hidden) return;
      if (e.code === 'Space') {
        e.preventDefault();
        Session.togglePause();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        Session.skip();
      }
    });

    // re-sincronización al volver visible / a pantalla completa
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (isRunningPhase(store.phase) || store.phase === STATE.PAUSED) {
          TimerEngine.forceTick();
          WakeLockManager.request();
        }
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const btn = $('#btn-fullscreen');
      btn.setAttribute('aria-pressed', document.fullscreenElement ? 'true' : 'false');
    });
  }

  function toggleFullscreen() {
    const el = document.documentElement;
    try {
      if (!document.fullscreenElement) {
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) req.call(el);
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
    } catch (e) { /* sin soporte */ }
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    const prefs = StorageManager.loadPrefs();
    if (prefs && prefs.theme === 'light') {
      document.body.classList.add('light');
      $('#toggle-theme').setAttribute('aria-pressed', 'true');
    }

    const last = StorageManager.loadLast();
    App.draft = App.normalizeWorkout(last || App.createDefaultWorkout());

    App.fillForm();
    App.renderExercises();
    App.renderCalculator();
    App.renderRoutines();

    AudioManager.enabled = App.draft.soundOn;
    SpeechManager.enabled = App.draft.voiceOn;

    bindEvents();
    UI.showScreen('config');
    SelfTests.run();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
