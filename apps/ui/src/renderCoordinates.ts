import { AxesHelper, Matrix4 } from 'three';

/** Apply P to auxiliary axes only; existing asset geometry retains its engine basis. */
export function createClientAxes(size: number): AxesHelper {
  const helper = new AxesHelper(size);
  helper.matrixAutoUpdate = false;
  helper.matrix.copy(new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  return helper;
}
