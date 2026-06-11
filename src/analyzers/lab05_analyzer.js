'use strict';
import fs from 'fs';

/**
 * Detects Lab05 rubric items that need richer analysis than simple regex counting.
 *
 * C12 (zoom/stickers/freestyle) — one of three based on group:
 *   Group A – Zoom:              ctx.scale() is called at least once
 *   Group B – Stickers:         a "sticker" variable/class exists AND canvas has mousedown/mousemove
 *   Group C – Freestyle drawing: ctx.lineTo() is called AND canvas has mousedown/mousemove
 *
 * C13 (background/font color/font style) — one of three based on group:
 *   Group A – Background color:  model has a user-settable bgColor/backgroundColor property
 *   Group B – Font color:        model has a user-settable textColor/fontColor property
 *   Group C – Font style:        model has a user-settable fontSelect/fontFamily/font property
 */
export default function(jsFiles, analysis) {
    let scaleCount = 0;
    let lineToCount = 0;
    let hasMouseEvent = false;
    let hasStickerKeyword = false;
    let hasBgColor = false;
    let hasFontColor = false;
    let hasFontStyle = false;

    for (const filePath of jsFiles) {
        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { continue; }

        scaleCount += (content.match(/\bscale\(/g) || []).length;
        lineToCount += (content.match(/\blineTo\(/g) || []).length;
        if (/mousedown|mousemove/.test(content)) hasMouseEvent = true;
        if (/\bsticker/i.test(content)) hasStickerKeyword = true;

        if (/this\.(?:bgColor|backgroundColor|canvasBg)\s*=/.test(content)) hasBgColor = true;
        // #? covers private class fields (e.g. this.#fontFillColor = ...)
        if (/this\.#?(?:textColor|fontColor|fillColor|textFill|fontFillColor|fontFill)\s*=/.test(content)) hasFontColor = true;
        // Fallback: ctx.fillStyle assigned from any model property (e.g. nested objects like this.#textSettings.fontFillColor)
        if (!hasFontColor && /ctx\.fillStyle\s*=\s*this\.#?\w/.test(content)) hasFontColor = true;
        if (/this\.#?(?:fontSelect|fontFamily|fontStyle|font)\s*=/.test(content)) hasFontStyle = true;
    }

    const hasZoom      = scaleCount >= 1;
    const hasFreestyle = lineToCount >= 1 && hasMouseEvent;
    const hasStickers  = hasStickerKeyword && hasMouseEvent;

    analysis.features.c12_feature_ok = (hasZoom || hasFreestyle || hasStickers) ? 1 : 0;
    analysis.features.c13_feature_ok = (hasBgColor || hasFontColor || hasFontStyle) ? 1 : 0;
};
