/**
 * `word-rise` (DS §4): headline words slide up in a mask, 70ms apart. Pure CSS
 * (globals.css); reduced motion collapses it to an instant change. Accent words
 * (italic, gold) are marked with *asterisks*: "Hair that *turns* heads."
 *
 * The space between words sits OUTSIDE each `.word-mask`. The mask is an
 * inline-block, and a trailing space inside an inline-block is collapsed, which
 * glued the words together ("Hairthatturns").
 */

import { Fragment } from "react";

export function WordRise({ text, accentClass = "text-gold" }: { text: string; accentClass?: string }) {
  const words = text.split(" ");
  return (
    <>
      {words.map((w, i) => {
        const accent = /^\*.+\*[.,]?$/.test(w);
        const clean = w.replace(/\*/g, "");
        return (
          <Fragment key={i}>
            <span className="word-mask">
              <span style={{ ["--i" as string]: i }}>{accent ? <em className={accentClass}>{clean}</em> : clean}</span>
            </span>
            {i < words.length - 1 ? " " : null}
          </Fragment>
        );
      })}
    </>
  );
}
