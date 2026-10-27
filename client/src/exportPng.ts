import type { Shape } from "@liveboard/shared";
import { drawShape } from "./drawing";
import { contentBounds, shapesToSvg } from "./exportSvg";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const inLayerOrder = (shapes: Shape[]) =>
  [...shapes].sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1));

export interface ExportOptions {
  background?: string | null; // a colour, or null for a transparent image
}

// Renders the whole board (not just the visible part) to a PNG.
export function renderPng(shapes: Shape[], options: ExportOptions = {}): Promise<Blob> {
  const box = contentBounds(shapes);
  const scale = 2; // sharper on high-DPI screens
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.width * scale);
  canvas.height = Math.ceil(box.height * scale);
  const ctx = canvas.getContext("2d")!;
  const background = options.background === undefined ? "#ffffff" : options.background;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.translate(-box.x, -box.y);
  for (const shape of inLayerOrder(shapes)) drawShape(ctx, shape);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("could not render the image"))), "image/png"),
  );
}

export async function exportPng(shapes: Shape[], name: string, options?: ExportOptions): Promise<void> {
  download(await renderPng(shapes, options), `${name}.png`);
}

// Put the picture on the clipboard, ready to paste into a document or chat.
export async function copyPng(shapes: Shape[], options?: ExportOptions): Promise<void> {
  const blob = await renderPng(shapes, options);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function exportSvg(shapes: Shape[], name: string, options?: ExportOptions): void {
  download(new Blob([shapesToSvg(shapes, options)], { type: "image/svg+xml" }), `${name}.svg`);
}
