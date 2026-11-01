import { captureFov } from './scene.ts';
/** Intentional simulation fill, not a calibrated physical camera profile. */
export const formalProfile = Object.freeze({
  profile_id: 'threejs-detail-v1',
  three_revision: '180',
  internal_resolution: 2048,
  output_resolution: 1024,
  supersampling: 2,
  output_color_space: 'srgb',
  tone_mapping: 'ACESFilmic',
  exposure: 1.2,
  grayscale: 'output_rec709',
  environment: 'RoomEnvironment',
  environment_intensity: 0.35,
  fill_intensity: 0.6,
  fill_position_radius: Object.freeze([-3, 2, 3]),
  shadow_type: 'PCFSoftShadowMap',
  shadow_map_size: 2048,
  shadow_extent_radius: 1.2,
  shadow_distance_radius: 5,
  shadow_far_radius: 12,
  shadow_bias: -0.0001,
  shadow_normal_bias_radius: 0.0005,
  downsample: 'Lanczos',
});
export function captureCameraParameters(radius: number, distance: number) {
  return {
    fov: (captureFov(radius) * 180) / Math.PI,
    near: Math.max(0.001, distance - 2 * radius),
    far: distance + 2 * radius + 1,
  };
}
