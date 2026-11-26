import 'pixi.js/unsafe-eval';
import {
  Application, Container, Mesh, MeshGeometry, RenderTexture, Shader, Sprite, Texture, UniformGroup,
  type WebGLRenderer,
} from 'pixi.js';
import {Actors} from './actors';
import {diskTexture, loadFarmAtlas} from './atlas';
import {
  cameraShift, fitViewport, followCamera, LANDSCAPE_VIEW, portraitViewport, setCurrentViewport, TILE_SIZE, type ViewSize,
} from './camera';
import {LIGHT_MASKS, lightingAt, lightLook} from './lighting';
import {Particles} from './particles';
import {qualitySettings, type QualityTier} from './quality';
import {rainGroundTint, rainWetting} from './terrain';
import {TerrainLayer} from './terrain-layer';
import type {ViewModel} from './view-model';

const COMPOSITE_VERTEX = `#version 300 es
  in vec2 aPosition;
  in vec2 aUV;
  out vec2 vUV;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vUV = aUV;
    vec3 position = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = `#version 300 es
  in vec2 vUV;
  out vec4 finalColor;
  uniform sampler2D uAlbedo;
  uniform sampler2D uLights;
  uniform vec3 uAmbient;
  uniform vec3 uShade;
  void main() {
    vec3 albedo = texture(uAlbedo, vUV).rgb;
    vec3 light = texture(uLights, vUV).rgb;
    // Split tone: light albedo takes the key light, dark albedo and shadows the shade colour.
    vec3 ambient = mix(uShade, uAmbient, smoothstep(.2, .66, dot(albedo, vec3(.299, .587, .114))));
    finalColor = vec4(albedo * (ambient + light), 1.0);
  }
`;

// The passes hold the view plus a one-tile margin (plan 8.4) and resize with it. A dynamic
// texture makes the display sprite follow the composite's new size.
function target() {
  return RenderTexture.create({
    width: LANDSCAPE_VIEW.width + TILE_SIZE, height: LANDSCAPE_VIEW.height + TILE_SIZE, resolution: 1, scaleMode: 'nearest',
    dynamic: true,
  });
}

function quadPositions(view: ViewSize) {
  const width = view.width + TILE_SIZE;
  const height = view.height + TILE_SIZE;
  return new Float32Array([0, 0, width, 0, width, height, 0, height]);
}

export async function createFarmRenderer(mount: HTMLElement, generatedBase: URL) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', {alpha: false, antialias: false, stencil: true});
  if (!context) throw new Error('The farm view requires WebGL2.');

  const app = new Application<WebGLRenderer>();
  await app.init({
    canvas, context, preference: ['webgl'], width: LANDSCAPE_VIEW.width, height: LANDSCAPE_VIEW.height,
    resolution: 1, antialias: false, autoStart: false, background: '#1f1720',
    failIfMajorPerformanceCaveat: false,
  });
  const atlas = await loadFarmAtlas(generatedBase).catch((error: unknown) => {
    app.destroy({removeView: true}, {children: true});
    throw error;
  });
  const renderer = app.renderer;
  const terrain = new TerrainLayer(atlas, renderer);
  const actors = new Actors(atlas);
  const particles = new Particles(atlas);
  const world = new Container();
  const lens = new Container();
  const lensTiles: Sprite[] = [];
  world.addChild(terrain.container, lens, actors.pipes, actors.shadows, actors.sprites, particles.container);

  const albedo = target();
  const lightBuffer = target();
  const composite = target();

  const lightStage = new Container();
  const lightMasks = Object.fromEntries(Object.entries(LIGHT_MASKS).map(([name, {width, height, rings}]) =>
    [name, diskTexture(width, height, rings)])) as Record<keyof typeof LIGHT_MASKS, ReturnType<typeof diskTexture>>;
  const lightSprites: Sprite[] = [];
  const blend = new UniformGroup({
    uAmbient: {value: new Float32Array(3), type: 'vec3<f32>'},
    uShade: {value: new Float32Array(3), type: 'vec3<f32>'},
  });
  const shader = Shader.from({
    gl: {vertex: COMPOSITE_VERTEX, fragment: COMPOSITE_FRAGMENT, name: 'farm-light-composite'},
    resources: {uAlbedo: albedo.source, uLights: lightBuffer.source, blend},
  });
  const geometry = new MeshGeometry({
    positions: quadPositions(LANDSCAPE_VIEW),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const quad = new Mesh({geometry, shader});
  const compositeStage = new Container();
  compositeStage.addChild(quad);
  const display = app.stage.addChild(new Sprite(composite));
  canvas.className = 'farm-canvas';
  canvas.setAttribute('aria-label', 'Farm view');
  mount.appendChild(canvas);

  let scale = 1;
  let dpr = 0;
  let view = LANDSCAPE_VIEW;
  let mapHeight = Infinity;
  let cameraAt = '';
  let runningDrip: boolean | undefined;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = mount.getBoundingClientRect();
    // The portrait layout in farm-ui.css sets --farm-fit: width on the game's scene mount.
    const portrait = getComputedStyle(mount).getPropertyValue('--farm-fit').trim() === 'width';
    const [deviceWidth, deviceHeight] = [Math.round(rect.width * dpr), Math.round(rect.height * dpr)];
    const viewport = portrait ? portraitViewport(deviceWidth, deviceHeight, mapHeight)
      : {...fitViewport(deviceWidth, deviceHeight), view: LANDSCAPE_VIEW};
    scale = viewport.scale;
    if (viewport.view.width !== view.width || viewport.view.height !== view.height) {
      view = viewport.view;
      for (const texture of [albedo, lightBuffer, composite]) texture.resize(view.width + TILE_SIZE, view.height + TILE_SIZE);
      geometry.positions = quadPositions(view);
    }
    setCurrentViewport(view, scale);
    // The canvas carries its logical view size and camera position; the browser tests read both.
    canvas.dataset.view = view.width + 'x' + view.height;
    renderer.resize(viewport.width, viewport.height);
    display.scale.set(scale);
    Object.assign(canvas.style, {
      width: viewport.width / dpr + 'px', height: viewport.height / dpr + 'px',
      left: viewport.left / dpr + 'px', top: viewport.top / dpr + 'px',
    });
  }
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(mount);
  resize();

  const restore = () => terrain.invalidate();
  canvas.addEventListener('webglcontextrestored', restore);

  return {
    canvas,
    atlasRegion(id: string) {
      const {image, width, height} = atlas.data;
      return {image, width, height, frame: atlas.frame(id)};
    },
    render(vm: Readonly<ViewModel>, animationMs: number, quality: QualityTier = 'standard', playerElapsedMs?: number) {
      if (renderer.context.isLost) return;
      // A portrait view is no taller than the map.
      if (dpr !== (window.devicePixelRatio || 1) || vm.map.height * TILE_SIZE !== mapHeight) {
        mapHeight = vm.map.height * TILE_SIZE;
        resize();
      }
      const camera = followCamera(vm.map, vm.player.at, view);
      const shiftX = cameraShift(camera.subX, scale);
      const shiftY = cameraShift(camera.subY, scale);
      const at = (camera.x + shiftX / scale) + ',' + (camera.y + shiftY / scale);
      if (at !== cameraAt) canvas.dataset.camera = cameraAt = at;
      const lighting = lightingAt(vm.sky);
      world.position.set(-camera.x, -camera.y);
      lightStage.position.copyFrom(world.position);

      // Dirty terrain chunks are rebuilt before their cached textures enter the world pass.
      terrain.sync(vm.map, rainWetting(vm.sky), rainGroundTint(vm.sky));
      lens.visible = vm.hud.moistureLens;
      if (lens.visible) {
        let index = 0;
        for (const tile of vm.map.tiles) {
          if (tile.wetness === null) continue;
          const mark = lensTiles[index] ??= lens.addChild(new Sprite(Texture.WHITE));
          mark.position.set(tile.at.x * TILE_SIZE, tile.at.y * TILE_SIZE);
          mark.width = mark.height = TILE_SIZE;
          mark.tint = tile.wetness >= .5 ? '#50b3ed' : '#ffc36e';
          mark.alpha = .25 + .3 * Math.abs(tile.wetness - .5);
          index++;
        }
      }
      actors.sync(vm, lighting, animationMs, playerElapsedMs);
      const dripWet = vm.dripLine.some(tile => tile.wet);
      if (dripWet !== runningDrip) {
        runningDrip = dripWet;
        canvas.setAttribute('aria-description', dripWet ? 'Drip line running' : 'Drip line idle');
      }
      particles.sync(vm, camera, view, animationMs, qualitySettings(quality).particleLimit, actors.wetEmitters);
      renderer.render({container: world, target: albedo, clear: true, clearColor: '#3b2a33'});

      for (let i = 0; i < actors.lights.length; i++) {
        const light = actors.lights[i];
        const sprite = lightSprites[i] ??= lightStage.addChild(new Sprite({blendMode: 'add', anchor: .5}));
        // Pooled sprites change kind between frames, so every property is set each time.
        const look = lightLook(light.kind);
        sprite.texture = lightMasks[look.mask];
        sprite.width = look.width;
        sprite.height = look.height;
        sprite.tint = look.tint;
        sprite.alpha = light.strength;
        sprite.position.set(light.x, light.y);
        sprite.visible = true;
      }
      for (let i = actors.lights.length; i < lightSprites.length; i++) lightSprites[i].visible = false;
      renderer.render({container: lightStage, target: lightBuffer, clear: true, clearColor: [0, 0, 0, 0]});

      blend.uniforms.uAmbient.set(lighting.ambient);
      blend.uniforms.uShade.set(lighting.shade);
      blend.update();
      renderer.render({container: compositeStage, target: composite, clear: true});

      display.position.set(-shiftX, -shiftY);
      app.render();
    },
    destroy() {
      sizeObserver.disconnect();
      canvas.removeEventListener('webglcontextrestored', restore);
      terrain.clear();
      world.destroy({children: true});
      lightStage.destroy({children: true});
      compositeStage.destroy({children: true});
      geometry.destroy();
      shader.destroy();
      actors.destroy();
      for (const mask of Object.values(lightMasks)) mask.destroy(true);
      atlas.destroy();
      albedo.destroy(true);
      lightBuffer.destroy(true);
      composite.destroy(true);
      app.destroy({removeView: true}, {children: true});
    },
  };
}
