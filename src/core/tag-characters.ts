/** Character ownership shared by native tag parsing and emission.
 *
 * The qualified native app/worker tag matchers exclude ASCII punctuation,
 * whitespace and the General/Supplemental Punctuation Unicode blocks.
 * Native non-numeric validation rejects ASCII digits only. Unicode letters,
 * combining characters, symbols and digits retain their exact spelling.
 */
const excludedAscii = new Set(Array.from("'!\"#$%&()*+,.:;<=>?@^`{|}~[]\\"));

export function isObsidianTagCharacter(character: string): boolean {
  const point = character.codePointAt(0);
  return point !== undefined && character === String.fromCodePoint(point) && !excludedAscii.has(character) && !/\s/u.test(character) &&
    !(point >= 0x2000 && point <= 0x206f) && !(point >= 0x2e00 && point <= 0x2e7f);
}

export function isObsidianTagName(value: string): boolean {
  return value.length > 0 && !value.includes(String.fromCharCode(0)) && !/^[0-9]+$/.test(value) &&
    Array.from(value).every(isObsidianTagCharacter);
}

export function isObsidianTagText(value: string): boolean {
  return !value.includes(String.fromCharCode(0)) && Array.from(value).every(isObsidianTagCharacter);
}
