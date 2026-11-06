export type DomKeyboardEventLike = {
  code: string;
  key: string;
  location?: number;
};

const ANDROID_KEY_CODES_BY_DOM_CODE: Record<string, number> = {
  Backquote: 68,
  Backslash: 73,
  Backspace: 67,
  BracketLeft: 71,
  BracketRight: 72,
  Comma: 55,
  Delete: 112,
  End: 123,
  Enter: 66,
  Equal: 70,
  Escape: 111,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
  Home: 122,
  Insert: 124,
  Minus: 69,
  PageDown: 93,
  PageUp: 92,
  Period: 56,
  Quote: 75,
  Semicolon: 74,
  Slash: 76,
  Space: 62,
  Tab: 61,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  ArrowUp: 19,
  AltLeft: 57,
  AltRight: 58,
  ControlLeft: 113,
  ControlRight: 114,
  MetaLeft: 117,
  MetaRight: 118,
  ShiftLeft: 59,
  ShiftRight: 60,
};

// 小键盘运算符：缺了它们，数字小键盘的 + - * / 和回车都没反应。
Object.assign(ANDROID_KEY_CODES_BY_DOM_CODE, {
  NumpadDivide: 154,
  NumpadMultiply: 155,
  NumpadSubtract: 156,
  NumpadAdd: 157,
  NumpadDecimal: 158,
  NumpadEnter: 160,
});

for (let index = 0; index < 10; index += 1) {
  ANDROID_KEY_CODES_BY_DOM_CODE[`Digit${index}`] = index === 0 ? 7 : 7 + index;
  ANDROID_KEY_CODES_BY_DOM_CODE[`Numpad${index}`] = 144 + index;
}

for (let index = 0; index < 26; index += 1) {
  ANDROID_KEY_CODES_BY_DOM_CODE[`Key${String.fromCharCode(65 + index)}`] = 29 + index;
}

// 只按物理键位（event.code）查表。查不到就返回 undefined ——
// 不要把 event.key 当键码发出去：被控端按字符解析时，一个 "CapsLock" 之类的字符串
// 可能被当成真实按键（大写锁死就是这么来的），字母大小写也会随本机布局漂移。
export function toAndroidKeyCodeFromDomEvent(event: DomKeyboardEventLike): number | undefined {
  return ANDROID_KEY_CODES_BY_DOM_CODE[event.code];
}
