// GLSL. Physically based shading (GGX + Fresnel) under a small procedural studio: one shadowed key
// softbox overhead, a cool rim strip from behind, a faint fill. The disc shader additionally draws
// the actual spiral (from the lathe's radius table) and scatters light according to how hard each
// revolution is modulated (from the cut groove data).
import { FACE_W, FACE_D } from './booth.js';

const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
export const KEY = unit([-0.38, 0.30, 0.87]);
const RIM = unit([0.55, 0.78, 0.30]), FILL = unit([0.30, -0.80, 0.50]), STRIP = unit([-0.92, -0.10, 0.38]);
const v3 = (v) => `vec3(${v.map((x) => x.toFixed(5)).join(', ')})`;

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
uniform sampler2DShadow uShadow; uniform mat4 uLVP; uniform vec3 uEye; uniform vec4 uLamp;   // lamp: xyz, on
uniform vec4 uPool; uniform float uBooth;   // the key light's pool (centre, where it ends, where it is full); whether the mixer stands beside the deck
const vec3 L1 = ${v3(KEY)}, L2 = ${v3(FILL)}, L3 = ${v3(RIM)}, LS = ${v3(STRIP)};
const vec3 KEYC = vec3(2.5, 2.38, 2.2), RIMC = vec3(0.55, 0.62, 0.75), FILLC = vec3(0.05, 0.05, 0.06);
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float softbox(vec3 r, vec3 d, vec3 u, vec2 half_, float s) {
  float t = dot(r, d); if (t <= 0.02) return 0.0;
  u = normalize(u - d * dot(u, d)); vec3 w = cross(d, u), p = r / t - d;
  vec2 e = smoothstep(half_ + s, half_ - s, abs(vec2(dot(p, u), dot(p, w))));
  return e.x * e.y;
}
vec3 env(vec3 r, float rough) {                      // what a reflection sees: a dark room with softboxes
  float s = 0.02 + 0.9 * rough, k = 1.0 / (1.0 + 7.0 * rough * rough);
  vec3 c = vec3(0.010, 0.010, 0.013) + 0.022 * smoothstep(-0.3, 0.7, r.z);
  c += 7.0 * k * softbox(r, L1, vec3(1.0, 0.0, 0.0), vec2(0.55, 0.30), s) * vec3(1.0, 0.95, 0.88);
  c += 3.0 * k * softbox(r, LS, vec3(0.0, 1.0, 0.0), vec2(0.60, 0.07), s) * vec3(0.80, 0.88, 1.0);
  c += 4.0 * k * softbox(r, L3, vec3(0.0, 0.0, 1.0), vec2(0.34, 0.10), s) * vec3(0.85, 0.92, 1.0);
  return c;
}
float shadow(vec3 P, vec3 N) {
  vec4 q = uLVP * vec4(P + N * 0.0012, 1.0); vec3 s = q.xyz / q.w * 0.5 + 0.5;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  float a = 0.0, t = 1.4 / 2048.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) a += texture(uShadow, vec3(s.xy + vec2(float(i), float(j)) * t, s.z - 0.0009));
  return a / 9.0;
}
float pool(vec3 P) { return mix(0.05, 1.0, smoothstep(uPool.z, uPool.w, length(P.xy - uPool.xy))); }   // the key is a spot
vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 F0, vec3 diff, float rough) {
  float nl = max(dot(N, L), 0.0); if (nl <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V); float nh = max(dot(N, H), 0.0), nv = max(dot(N, V), 1e-3), a = rough * rough, a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0, D = min(a2 / (3.14159 * d * d), 40.0), k = (rough + 1.0) * (rough + 1.0) / 8.0;
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  return (diff + D * F / (4.0 * (nl * (1.0 - k) + k) * (nv * (1.0 - k) + k))) * nl;
}
vec3 shade(vec3 P, vec3 N, vec3 alb, float rough, float metal, float ao) {
  vec3 V = normalize(uEye - P), F0 = mix(vec3(0.04), alb, metal), diff = alb * (1.0 - metal);
  float sh = shadow(P, N), nv = max(dot(N, V), 1e-3);
  vec3 c = brdf(N, V, L1, F0, diff, rough) * KEYC * sh * pool(P) + brdf(N, V, L3, F0, diff, rough) * RIMC * ao + brdf(N, V, L2, F0, diff, rough) * FILLC;
  vec3 lp = uLamp.xyz - P; float ld = length(lp);
  c += brdf(N, V, lp / ld, F0, diff, max(rough, 0.3)) * vec3(1.0, 0.10, 0.04) * uLamp.w * 1.6 / (1.0 + ld * ld / 0.0012) * mix(1.0, max(0.0, 1.0 - ld * ld / 0.04), uBooth);   // in the booth it ends before the other deck's picture starts
  vec3 F = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - nv, 5.0);
  return c + env(reflect(-V, N), rough) * F * ao * (0.45 + 0.55 * sh) + diff * 0.015 * ao;
}
vec3 tone(vec3 x) {
  x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2)) + (hash(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;

export const STD_VS = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN;
uniform mat4 uVP, uM; out vec3 vP, vN, vO;
void main() { vec4 w = uM * vec4(aP, 1.0); vP = w.xyz; vN = mat3(uM) * aN; vO = aP; gl_Position = uVP * w; }`;

export const DEPTH_FS = `#version 300 es
precision mediump float;
void main() {}`;

// uMode: 0 plain, 1 turned metal, 2 deck plate, 3 platter with strobe dots, 5 table top, 7 mixer faceplate, 8 level meter
export const STD_FS = COMMON + `
in vec3 vP, vN, vO; out vec4 o;
uniform mat4 uM; uniform vec3 uCol, uEmis; uniform float uRough, uMetal, uLevel; uniform int uMode; uniform vec2 uPivot; uniform sampler2D uFace;
float away(vec2 c, vec2 h) { vec2 q = abs(vP.xy - c) - h; return smoothstep(-0.01, 0.07, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0)); }   // 0 under a box's edge, 1 well clear of it
void main() {
  vec3 N = normalize(vN), alb = uCol, emis = uEmis; float rough = uRough, metal = uMetal, ao = 1.0;
  float ro = length(vO.xy), px = fwidth(vO.x) + fwidth(vO.y) + fwidth(vO.z);
  if (uMode == 1 || uMode == 3) {                       // lathe-turned: fine concentric brushing
    float b = hash(vec2(floor(ro * 5000.0), 3.0)) - 0.5, fade = 1.0 - smoothstep(1e-4, 6e-4, px);
    if (abs(N.z) > 0.5) { N = normalize(N + mat3(uM) * vec3(vO.xy / max(ro, 1e-4), 0.0) * b * 0.10 * fade); rough += b * 0.10 * fade; }
  }
  if (uMode == 3 && ro > 0.160 && abs(N.z) < 0.4) {     // strobe dots around the platter rim
    float row = clamp(floor((vO.z + 0.0200) / 0.003125), 0.0, 3.0), n = 180.0 - 6.0 * row;
    vec2 cell = vec2((fract(atan(vO.y, vO.x) / 6.2831853 * n) - 0.5) * 1.0336 / n, (fract((vO.z + 0.0200) / 0.003125) - 0.5) * 0.003125);
    float dot_ = 1.0 - smoothstep(0.0008, 0.0010 + px, length(cell));
    alb = mix(vec3(0.02), vec3(0.80, 0.80, 0.82), dot_); rough = mix(0.5, 0.22, dot_);
  }
  if (uMode == 2 && N.z > 0.5) {                        // deck plate: paint texture + contact occlusion
    alb *= 0.88 + 0.24 * hash(floor(vP.xy * 2500.0)) * (1.0 - smoothstep(2e-4, 1e-3, px));
    ao *= mix(0.35, 1.0, smoothstep(0.163, 0.205, length(vP.xy))) * mix(0.45, 1.0, smoothstep(0.028, 0.060, length(vP.xy - uPivot)));
  }
  if (uMode == 5) {                                     // table: occlusion under the plinth
    float clear = away(vec2(0.0425, 0.0), vec2(0.2275, 0.19));
    if (uBooth > 0.5) clear = min(clear, away(uPool.xy, vec2(0.165, 0.19)));
    ao *= mix(0.15, 1.0, clear);
    alb *= 0.9 + 0.2 * hash(floor(vP.xy * 900.0)) * (1.0 - smoothstep(5e-4, 3e-3, px));
  }
  if (uMode == 7 && N.z > 0.5) {                        // mixer faceplate: its printed artwork, faintly lit so it can be read in the dark
    vec3 art = texture(uFace, vO.xy / vec2(${FACE_W.toFixed(4)}, ${FACE_D.toFixed(4)}) + 0.5).rgb;
    alb = art * art * (0.94 + 0.12 * hash(floor(vP.xy * 2500.0)) * (1.0 - smoothstep(2e-4, 1e-3, px)));
    emis += art * art * 0.09;
  }
  if (uMode == 8 && N.z > 0.5) {                        // level meter: LEDs light up from the near end
    float t = (vO.y + 0.1) / 0.2 * 16.0, n = (floor(t) + 0.5) / 16.0, gap = smoothstep(0.1, 0.18, min(fract(t), 1.0 - fract(t)));
    vec3 led = n < 0.62 ? vec3(0.15, 1.0, 0.3) : n < 0.86 ? vec3(1.0, 0.65, 0.1) : vec3(1.0, 0.12, 0.08);
    emis += led * gap * (n < uLevel ? 1.3 : 0.03);
  }
  o = vec4(tone(shade(vP, N, alb, clamp(rough, 0.06, 1.0), metal, ao) + emis), 1.0);
}`;

export const REC_VS = `#version 300 es
layout(location=0) in vec3 aP;
uniform mat4 uVP, uM; uniform vec3 uWarp[3];   // (harmonic k, amplitude m, phase)
out vec3 vP, vN; out vec2 vQ;
void main() {
  float r = length(aP.xy), phi = atan(aP.y, aP.x), t = max(0.0, (r - 0.0532) / (0.1508 - 0.0532));
  float z = 0.0, dzr = 0.0, dzp = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = uWarp[i].x * phi + uWarp[i].z;
    z += uWarp[i].y * t * t * cos(a); dzr += uWarp[i].y * 2.0 * t / 0.0976 * cos(a); dzp -= uWarp[i].y * t * t * uWarp[i].x * sin(a);
  }
  vec2 er = aP.xy / max(r, 1e-5), ep = vec2(-er.y, er.x);
  vec3 n = normalize(vec3(-dzr * er - dzp / max(r, 1e-3) * ep, 1.0));
  vec4 w = uM * vec4(aP.xy, z, 1.0);
  vP = w.xyz; vN = mat3(uM) * n; vQ = aP.xy; gl_Position = uVP * w;
}`;

export const REC_FS = COMMON + `
in vec3 vP, vN; in vec2 vQ; out vec4 o;
uniform mat4 uM; uniform sampler2D uLut, uVis, uLabel;
uniform float uRLo, uRHi, uRows, uRevEnd, uW, uDust; uniform vec4 uScr[12]; uniform int uNScr;
float lut(float r) {
  float x = clamp((r - uRLo) / (uRHi - uRLo), 0.0, 1.0) * 2047.0; int i = int(floor(x));
  return mix(texelFetch(uLut, ivec2(i, 0), 0).r, texelFetch(uLut, ivec2(min(i + 1, 2047), 0), 0).r, x - float(i));
}
void main() {
  float r = length(vQ), phi = atan(vQ.y, vQ.x), ph = phi / 6.28318531;
  vec3 N = normalize(vN), V = normalize(uEye - vP);
  vec3 Tw = normalize(mat3(uM) * vec3(-sin(phi), cos(phi), 0.0));
  float px = fwidth(vQ.x) + fwidth(vQ.y), sh = shadow(vP, N), key = sh * pool(vP);
  vec3 c;
  if (r < 0.05) {                                              // paper label
    vec3 lab = texture(uLabel, vQ / 0.1 + 0.5).rgb;
    c = shade(vP, N, lab * lab, 0.75, 0.0, 1.0);
  } else {
    float revs = lut(r);
    float pitch = 2e-4 / max(1e-5, abs(lut(r - 1e-4) - lut(r + 1e-4)));   // metres between neighbouring grooves
    float g = revs - ph, n = floor(g + 0.5);                   // g is an integer on a groove centreline
    float inside = step(0.01, revs) * step(revs, uRevEnd - 0.01) * step(r, 0.1492);
    float dist = abs(fract(g + 0.5) - 0.5) * pitch;            // metres to the nearest groove centre
    float sharp = clamp((uW - dist) / max(px, 1e-7) + 0.5, 0.0, 1.0);
    float cover = inside * mix(sharp, min(1.0, 2.0 * uW / pitch), smoothstep(0.25, 0.9, px / pitch));
    float vis = texture(uVis, vec2(fract(ph), (n + floor(ph) + 0.5) / uRows)).r;   // modulation of this revolution
    // groove walls: a radial fan of 45-degree mirrors -> anisotropic streaks, widened by modulation
    float sig = 0.014 + 0.085 * vis; vec3 groove = vec3(0.0016) + vis * 0.003;
    for (int i = 0; i < 3; i++) {
      vec3 L = i == 0 ? L1 : (i == 1 ? L3 : LS), H = normalize(L + V);
      vec3 lc = i == 0 ? KEYC * key : (i == 1 ? RIMC * 1.6 : vec3(0.5, 0.56, 0.66));
      float th = dot(Tw, H), s = exp(-th * th / (2.0 * sig * sig)) * 0.0085 / sig * (0.3 + 0.7 * max(dot(N, H), 0.0));
      groove += s * lc * (vec3(0.72, 0.70, 0.67) + 0.28 * cos(6.2832 * (th * 9.0 + r * 55.0 + vec3(0.0, 0.33, 0.67))));
    }
    float fr = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 land = vec3(0.0012) + env(reflect(-V, N), 0.07) * (0.045 + 0.955 * fr) * (0.5 + 0.5 * sh) + brdf(N, V, L1, vec3(0.045), vec3(0.002), 0.12) * KEYC * key;
    c = mix(land, groove, cover);
    for (int i = 0; i < uNScr; i++) {                          // scratches catch the light
      vec4 s = uScr[i];
      if (r > s.x && r < s.y) {
        float d = abs(mod(phi - mix(s.z, s.w, (r - s.x) / (s.y - s.x)) + 3.14159265, 6.28318531) - 3.14159265) * r;
        c += 0.03 * (0.3 + key) * (1.0 - smoothstep(0.0, 40e-6 + px, d));
      }
    }
    vec2 cell = floor(vQ / 4e-4);                              // dust specks
    if (hash(cell) < uDust * 0.0016) c += 0.05 * (0.3 + key) * (1.0 - smoothstep(0.0, 6e-5 + px, length(vQ / 4e-4 - cell - 0.5) * 4e-4));
  }
  o = vec4(tone(c), 1.0);
}`;
