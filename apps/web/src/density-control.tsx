import { useEffect, useState } from "react";

type Density = "compact" | "comfortable";

const DENSITY_STORAGE_KEY = "relay-density";

function readDensity(): Density {
  if (typeof window === "undefined") return "compact";
  return window.localStorage.getItem(DENSITY_STORAGE_KEY) === "comfortable" ? "comfortable" : "compact";
}

export function DensityControl() {
  const [density, setDensity] = useState<Density>(readDensity);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  function chooseDensity(nextDensity: Density) {
    setDensity(nextDensity);
    window.localStorage.setItem(DENSITY_STORAGE_KEY, nextDensity);
  }

  return (
    <div aria-label="Interface density" className="density-control" role="group">
      <button aria-pressed={density === "compact"} onClick={() => chooseDensity("compact")} type="button">Compact</button>
      <button aria-pressed={density === "comfortable"} onClick={() => chooseDensity("comfortable")} type="button">Comfortable</button>
    </div>
  );
}
