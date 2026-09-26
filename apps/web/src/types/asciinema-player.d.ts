// asciinema-player ships no type definitions; this covers what Skiff uses.
declare module "asciinema-player" {
  export interface Player {
    dispose(): void;
  }
  export function create(
    src: string,
    element: HTMLElement,
    options?: Record<string, unknown>,
  ): Player;
}

// Side-effect stylesheet import (Vite bundles it).
declare module "asciinema-player/dist/bundle/asciinema-player.css";
