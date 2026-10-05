import { useEffect, useRef } from "react";

type Layer = { close: () => void };

const layers: Layer[] = [];

/** Escape closes the top dialog only. Mount order is the stack order. */
export function useDialogLayer(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const layer: Layer = { close: () => onCloseRef.current() };
    layers.push(layer);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (layers[layers.length - 1] !== layer) return;
      event.preventDefault();
      event.stopPropagation();
      layer.close();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }, []);
}
