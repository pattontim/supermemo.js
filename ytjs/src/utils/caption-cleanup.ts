/**
 * Remove VTT cue span tags (like <c.colorXXXXXX>, <b>, </b>, </c>, etc.)
 * but preserve the text content inside
 */
function removeVTTTags(text: string): string {
  return text
    // Remove VTT color span tags: <c.colorXXXXXX>...</c>
    .replace(/<c\.[a-zA-Z0-9]+>/g, '')
    // Remove closing tags
    .replace(/<\/c>/g, '')
    .replace(/<\/b>/g, '')
    .replace(/<\/i>/g, '')
    .replace(/<\/u>/g, '')
    // Remove opening tags (including other formatting)
    .replace(/<b>/g, '')
    .replace(/<i>/g, '')
    .replace(/<u>/g, '')
    // Remove any remaining malformed tags
    .replace(/<[^>]+>/g, '');
}

/**
 * Normalize a single caption line
 * @param line The caption line text
 * @returns Cleaned caption line
 */
function normalizeCaptionLine(line: string): string {
  if (!line || !line.trim()) {
    return '';
  }

  let cleaned = removeVTTTags(line)
    // Remove &nbsp; entities
    .replace(/&nbsp;/g, ' ')
    // Remove zero-width spaces (U+200B)
    .replace(/\u200B/g, '')
    // Remove zero-width joiner (U+200D)
    .replace(/\u200D/g, '')
    // Remove zero-width non-joiner (U+200C)
    .replace(/\u200C/g, '')
    // Remove other non-visible characters (soft hyphens, zero-width no-break space, etc.)
    .replace(/[\u00AD\uFEFF\u180E]/g, '')
    // Remove multiple consecutive spaces
    .replace(/  +/g, ' ')
    // Trim
    .trim();

  return cleaned;
}

/**
 * Check if a line is just a single character (possibly with tags)
 */
function isSingleCharLine(line: string): boolean {
  const cleaned = removeVTTTags(line).trim();
  // Match single character (including multi-byte characters like Japanese)
  return /^.$/u.test(cleaned);
}

/**
 * Normalize VTT caption content to clean up formatting issues
 * - Removes VTT color and style tags
 * - Consolidates multi-line character spam into single lines
 * - Removes duplicate cues with identical timestamps AND content
 * - Preserves valid VTT structure
 * @param vttContent The complete VTT file content
 * @returns Cleaned VTT content
 */
export function normalizeCaptions(
  vttContent: string
): string {
  if (!vttContent) {
    return vttContent;
  }

  const lines = vttContent.split('\n');
  const result: string[] = [];
  const seenCues = new Set<string>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check if this is a timing line
    const timingMatch = line.match(/^(\d{1,2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3})/);
    
    if (timingMatch) {
      const timingLine = line.trim();
      i++;

      // Collect cue content lines
      let cueLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        cueLines.push(lines[i]);
        i++;
      }

      // Process cue lines: consolidate single characters into one line
      let consolidatedLines: string[] = [];
      let charBuffer: string[] = [];

      for (let j = 0; j < cueLines.length; j++) {
        const cueLine = cueLines[j];

        if (isSingleCharLine(cueLine)) {
          charBuffer.push(removeVTTTags(cueLine).trim());
        } else {
          // Not a single character line
          if (charBuffer.length > 0) {
            // Flush character buffer
            consolidatedLines.push(charBuffer.join(''));
            charBuffer = [];
          }
          const cleaned = normalizeCaptionLine(cueLine);
          if (cleaned) {
            consolidatedLines.push(cleaned);
          }
        }
      }

      // Flush remaining characters
      if (charBuffer.length > 0) {
        consolidatedLines.push(charBuffer.join(''));
      }

      // Create a unique key for this cue (timing + normalized content)
      const contentKey = consolidatedLines
        .filter(cl => cl.trim())
        .join('|')
        .trim();
      const cueKey = `${timingLine}||${contentKey}`;

      // Skip if we've already seen this exact cue
      if (seenCues.has(cueKey)) {
        // Skip the blank line too
        if (i < lines.length && lines[i].trim() === '') {
          i++;
        }
        continue;
      }

      seenCues.add(cueKey);
      result.push(timingLine);

      // Add consolidated lines to result
      for (const cl of consolidatedLines) {
        if (cl.trim()) {
          result.push(cl);
        }
      }

      // Add blank line separator
      if (i < lines.length) {
        result.push('');
        i++;
      }
    } else {
      // Not a timing line - keep as is (headers, etc.)
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

/**
 * Remove IE11-incompatible VTT styling
 * This is already handled by transformWebVTT in server.ts,
 * but this function can be used for post-processing saved files
 */
export function removeIE11IncompatibleStyling(vttContent: string): string {
  if (!vttContent) {
    return vttContent;
  }

  const styleRegex = /Style:\n(::cue\(.*?\)\s*{\s*.*?\s*}\n?)*\n?##\n?/gs;
  return vttContent
    .replace(/Kind:.*\n/g, '')
    .replace(/Language:.*\n/g, '')
    .replace(styleRegex, '');
}
