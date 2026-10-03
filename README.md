# Workout Interval Timer

Cronómetro de entrenamiento por intervalos en **HTML5 + CSS3 + JavaScript vanilla (ES6+)**, sin frameworks ni dependencias. Optimizado para móvil.

La idea central:

> El tiempo general representa **solo tiempo activo de ejercicio**. Los segundos de descanso/transición **NO** se descuentan del tiempo general.

Así, una sesión de 30:00 activos con descansos intermedios dura físicamente más de 30 minutos, pero el trabajo realizado es exactamente 30:00.

---

## Cómo ejecutarlo

No requiere build ni servidor.

1. Abre `workout-timer/index.html` en un navegador moderno (doble clic).
2. (Recomendado en móvil) sírvelo por HTTP para que algunas APIs funcionen mejor, por ejemplo:

```bash
# opción A: Python
python -m http.server 8080
# luego abre http://localhost:8080/workout-timer/

# opción B: Node
npx serve workout-timer
```

3. Pulsa **Iniciar entrenamiento**. La primera vez el navegador pedirá interacción para habilitar el audio: el `AudioContext` se desbloquea al iniciar.

---

## Estructura

```text
workout-timer/
  index.html   Interfaz (config, sesión, resumen)
  styles.css   Tema oscuro deportivo, mobile-first, variables CSS
  app.js       Lógica completa (sin librerías)
  README.md
```

---

## Arquitectura (app.js)

El código está dividido en módulos conceptuales dentro de una IIFE:

| Módulo | Responsabilidad |
| --- | --- |
| `Utils` | formato de tiempo, `clamp`, `crypto.randomUUID` con fallback, clonado, vibración |
| `StorageManager` | persistencia en `localStorage` (última rutina, rutinas guardadas, preferencias) |
| `AudioManager` | beeps generados con Web Audio API (inicio, descanso, 3-2-1, fin) |
| `SpeechManager` | anuncios con `speechSynthesis` (con comprobación de soporte) |
| `WakeLockManager` | Screen Wake Lock opcional |
| `WorkoutLogic` | **lógica pura**: genera la secuencia de segmentos y estima la duración real |
| `SelfTests` | assertions de la lógica pura sobre casos límite |
| `store` | estado + máquina de estados explícita |
| `TimerEngine` | bucle `requestAnimationFrame` basado en `performance.now()` |
| `Session` | transiciones de la máquina de estados |
| `UI` | render desacoplado del cálculo (no decide tiempos, solo pinta el estado) |

### Máquina de estados

```text
CONFIG → READY → COUNTDOWN → WORK → REST → WORK → … → FINISHED
WORK/REST/COUNTDOWN → PAUSED → (vuelve al estado anterior)
```

No hay booleanos contradictorios: todo se decide por `store.phase` y `store.previousPhase`.

### Modelo de tiempo (sin drift)

El temporizador **no** resta 1 por segundo. Se usa:

```text
tiempoRestante = duraciónFase - (tiempoTranscurridoReal dentro de la fase)
```

- La lógica avanza con `dt` real (`performance.now()`), acumulado por `requestAnimationFrame`.
- Al consumir `dt` se pueden atravesar varias fases de golpe (p. ej. al volver de una pestaña oculta), de modo que nunca se pierde tiempo.
- El render está separado del cálculo: aunque la pestaña se ralentice, el tiempo es correcto.
- Al pausar simplemente se deja de consumir `dt`: no hay saltos al reanudar.
- Un `dt` grande (>1.5 s) silencia sonidos para evitar ráfagas en la re-sincronización.

### Reglas de negocio clave

- El **tiempo activo** solo baja en fase `WORK`.
- El último ejercicio se **trunca** si queda menos tiempo activo que su duración.
- No hay descanso tras el último ejercicio si el tiempo activo ya llegó a 0.
- **Saltar**: conserva el tiempo activo aún no trabajado (el tiempo ya trabajado del ejercicio actual sí se contabiliza).
- **Pausar**: congela a la vez trabajo, descanso, tiempo activo y transiciones automáticas.
- Modo **repetir** (por defecto) repite el circuito hasta consumir el objetivo; modo **una vuelta** termina tras la primera pasada.

---

## Funciones incluidas

- Tiempo activo objetivo en horas/minutos/segundos.
- Descanso configurable (0–300 s) y cuenta regresiva inicial (0/3/5/10 s).
- Ejercicios dinámicos (1–50): nombre, duración, añadir, eliminar, duplicar, reordenar (↑/↓).
- Repetición de circuito con contador de vueltas.
- Calculadora previa de duración real (incluye descansos y cuenta regresiva).
- Pantalla de entrenamiento con estado, tiempo gigante, ejercicio actual, siguiente, vuelta y dos barras de progreso.
- Sonidos distintos (inicio, descanso, 3-2-1, fin) e interruptores de Sonido/Voz.
- Controles grandes: Pausar/Reanudar, Saltar, Anterior, Reiniciar, Salir; atajos de teclado.
- Resumen final completo con tiempos, ejercicios, vueltas y horas.
- Persistencia en `localStorage`, rutinas guardadas (guardar/cargar/renombrar/eliminar) e importar/exportar JSON.
- Presets HIIT / Tabata / Movilidad.
- Extras: pantalla completa, vibración (`navigator.vibrate`), tema claro/oscuro, descanso opcional entre vueltas, Screen Wake Lock.
- Accesibilidad: `<label>`, botones semánticos, `aria-live` para eventos importantes, `aria-pressed`, foco visible, `prefers-reduced-motion`, contraste alto.

---

## Pruebas realizadas

**Assertions integradas** (`SelfTests.run()` se ejecuta al cargar y registra en consola):

- Caso 1: 30:00 activo, 5×30 s, descanso 5 s, repetir → trabajo total exacto 1 800 000 ms, 59 transiciones, duración real 34:58.
- Caso 2: 2:00 activo, 3×45 s, descanso 5 s → último ejercicio truncado a 30 s, 2 transiciones.
- Caso 3: descanso 0 → ninguna transición.
- Caso 8: activo menor que el primer ejercicio → primer ejercicio truncado.
- Modo una vuelta → solo 5 trabajos, sin descanso final.

**Pruebas end-to-end en navegador (headless, DevTools Protocol):**

1. Carga sin errores de consola; se generan los 5 ejercicios y el resumen calcula 34:58.
2. Inicio → `PREPÁRATE` con el **tiempo activo congelado** en 30:00.
3. `WORK` → el tiempo activo decrece; la pausa congela tiempo de ejercicio y tiempo activo; al reanudar continúa sin salto.
4. Sesión de 8 s activos + 2 s descanso + 2 ejercicios de 5 s → durante `DESCANSO` el activo permanece en 00:03 (congelado), y el resumen final da: objetivo 00:08, completado 00:08, real 00:10, descansos 00:02, 2 ejercicios, 1 vuelta.
5. Saltar a mitad conserva el tiempo ya trabajado (00:16 antes y después, sin reiniciar a 00:20) y avanza de ejercicio.

Consola sin errores en todas las pruebas.

---

## Confirmación explícita

**Los descansos NO consumen tiempo activo.** El contador de tiempo activo general se descuenta únicamente durante la fase `WORK`; durante `REST`, `PAUSED`, `COUNTDOWN` y configuración permanece congelado. Verificado por el algoritmo puro, por las assertions y por las pruebas end-to-end.

---

## Mejoras opcionales pendientes

Instalación como PWA (`manifest.webmanifest` + service worker). El resto de mejoras opcionales (pantalla completa, vibración, presets, import/export, descanso entre vueltas, tema claro/oscuro) ya están implementadas.
