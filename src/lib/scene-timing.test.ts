import { sceneDurationForVoice } from "./scene-timing";

test("scene lasts the spoken phrase plus 0.6s", () => {
  expect(sceneDurationForVoice(2.4)).toBe(3);
});
test("very short phrases still get at least 2.2s on screen", () => {
  expect(sceneDurationForVoice(0.8)).toBe(2.2);
});
