/**
 * The backdrop: nebula gradient, two star layers, one distant moon.
 *
 * Drawn with `depthTest: false` and a very negative render order, so the
 * backdrop is unconditionally behind everything without needing a far plane
 * large enough to contain it geometrically.
 */

import * as THREE from 'three'
import { chunk } from '../core/geo'
import type { Rng } from '../core/rng'

const NEBULA_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const NEBULA_FRAG = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uCloudA;
  uniform vec3 uCloudB;
  uniform vec3 uDirA;
  uniform vec3 uDirB;
  uniform vec3 uBandNormal;

  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);

    // Vertical wash: warmer indigo below the orbital plane, colder above.
    float v = d.y * 0.5 + 0.5;
    vec3 col = mix(uLow, uHigh, smoothstep(0.0, 1.0, v));

    // Two broad emission clouds give the sky a direction to remember.
    col += uCloudA * pow(max(0.0, dot(d, uDirA)), 5.0);
    col += uCloudB * pow(max(0.0, dot(d, uDirB)), 8.0);

    // A tight galactic band across the sphere.
    float band = 1.0 - abs(dot(d, uBandNormal));
    col += vec3(0.030, 0.038, 0.075) * pow(band, 16.0);

    gl_FragColor = vec4(col, 1.0);
  }
`

export interface Sky {
  group: THREE.Group
  update(dt: number): void
  dispose(): void
}

function buildNebula(): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial } {
  const geometry = new THREE.SphereGeometry(1, 24, 16)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLow: { value: new THREE.Color(0.020, 0.014, 0.052) },
      uHigh: { value: new THREE.Color(0.004, 0.006, 0.020) },
      uCloudA: { value: new THREE.Color(0.115, 0.020, 0.078) }, // magenta bloom
      uCloudB: { value: new THREE.Color(0.014, 0.070, 0.098) }, // teal bloom
      uDirA: { value: new THREE.Vector3(-0.62, 0.24, 0.75).normalize() },
      uDirB: { value: new THREE.Vector3(0.78, -0.12, 0.61).normalize() },
      uBandNormal: { value: new THREE.Vector3(0.28, 0.93, -0.24).normalize() },
    },
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  // Large enough that the camera is always inside the shell (so BackSide is
  // the correct face) but still inside the camera's far plane, since disabling
  // depth testing does not exempt geometry from frustum clipping.
  mesh.scale.setScalar(60000)
  mesh.renderOrder = -1000
  return { mesh, geometry, material }
}

function buildStarLayer(
  rng: Rng,
  count: number,
  size: number,
  radius: number,
  tints: number[],
): { points: THREE.Points; geometry: THREE.BufferGeometry; material: THREE.PointsMaterial } {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const tintColors = tints.map((t) => new THREE.Color(t))
  const dir = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    // Rejection-free uniform sphere sampling.
    const u = rng.range(-1, 1)
    const theta = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(Math.max(0, 1 - u * u))
    dir.set(r * Math.cos(theta), u, r * Math.sin(theta)).multiplyScalar(radius)
    positions[i * 3] = dir.x
    positions[i * 3 + 1] = dir.y
    positions[i * 3 + 2] = dir.z

    const c = tintColors[Math.floor(rng() * tintColors.length)]
    const b = rng.range(0.45, 1.0)
    colors[i * 3] = c.r * b
    colors[i * 3 + 1] = c.g * b
    colors[i * 3 + 2] = c.b * b
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.renderOrder = -900
  return { points, geometry, material }
}

/** A cratered rock far out on the night side, for depth and scale. */
function buildMoon(): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material } {
  const geometry = chunk(1, 3)
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  // Dent the sphere so the terminator is not a clean arc.
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i))
    const n = 1 + 0.05 * Math.sin(v.x * 7.3) * Math.cos(v.y * 5.1) + 0.03 * Math.sin(v.z * 11.7)
    pos.setXYZ(i, v.x * n, v.y * n, v.z * n)
  }
  geometry.computeVertexNormals()

  const material = new THREE.MeshPhongMaterial({
    color: 0x6d7486,
    flatShading: true,
    shininess: 2,
    emissive: 0x05070c,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.setScalar(1600)
  mesh.position.set(-14000, 5200, -22000)
  return { mesh, geometry, material }
}

export function buildSky(rng: Rng): Sky {
  const group = new THREE.Group()

  const nebula = buildNebula()
  const dim = buildStarLayer(rng, 3200, 1.4, 40000, [0xbfd8ff, 0xffffff, 0xffe6c4, 0xd8c4ff])
  const bright = buildStarLayer(rng, 240, 3.4, 40000, [0xffffff, 0x9fe6ff, 0xffd9a8, 0xff9fd0])
  const moon = buildMoon()

  group.add(nebula.mesh, dim.points, bright.points, moon.mesh)

  let t = 0
  return {
    group,
    update(dt: number) {
      // A whisper of rotation so the sky is not dead still on long fights.
      t += dt
      dim.points.rotation.y = t * 0.0012
      bright.points.rotation.y = t * 0.0012
    },
    dispose() {
      nebula.geometry.dispose()
      nebula.material.dispose()
      dim.geometry.dispose()
      dim.material.dispose()
      bright.geometry.dispose()
      bright.material.dispose()
      moon.geometry.dispose()
      moon.material.dispose()
    },
  }
}
