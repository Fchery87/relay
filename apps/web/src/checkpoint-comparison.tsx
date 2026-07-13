import { useEffect, useState } from "react";

import type { ThreadCheckpoint } from "./thread-messages";

export function CheckpointComparison({ checkpoints, onCompare }: {
  checkpoints: readonly ThreadCheckpoint[];
  onCompare(input: { fromCheckpointId: string; toCheckpointId: string }): Promise<unknown>;
}) {
  const [fromCheckpointId, setFromCheckpointId] = useState(checkpoints.at(-2)?._id ?? checkpoints[0]?._id ?? "");
  const [toCheckpointId, setToCheckpointId] = useState(checkpoints.at(-1)?._id ?? "");
  const checkpointKey = checkpoints.map(({ _id }) => _id).join(":");
  useEffect(() => {
    setFromCheckpointId(checkpoints.at(-2)?._id ?? checkpoints[0]?._id ?? "");
    setToCheckpointId(checkpoints.at(-1)?._id ?? "");
  }, [checkpointKey]);
  const options = checkpoints.map((checkpoint, index) => <option key={checkpoint._id} value={checkpoint._id}>Turn {index + 1}</option>);
  return <div className="checkpoint-comparison">
    <select aria-label="From checkpoint" onChange={(event) => setFromCheckpointId(event.target.value)} value={fromCheckpointId}>{options}</select>
    <select aria-label="To checkpoint" onChange={(event) => setToCheckpointId(event.target.value)} value={toCheckpointId}>{options}</select>
    <button disabled={checkpoints.length < 2 || !fromCheckpointId || !toCheckpointId || fromCheckpointId === toCheckpointId} onClick={() => void onCompare({ fromCheckpointId, toCheckpointId })} type="button">Compare</button>
  </div>;
}
