#!/usr/bin/env bash
#
# =============================================================================
# Docker container resource measurement script (Docker-native / "Path A")
# =============================================================================
#
# Purpose
# -------
# This script compares two Docker images by running one container for each and
# sampling resource usage *from the Docker engine* (i.e., from the host/cgroups),
# not from inside the application. This is intentionally "minimally intrusive":
#   - no agents inside the containers
#   - no app instrumentation
#   - uses the standard Docker CLI: `docker stats`
#
# It measures two scenarios:
#   1) COLD start: containers start with fresh, empty /data volumes
#   2) WARM start: containers start again reusing the same /data volumes
#
# Why cold vs warm?
# -----------------
# Many containers perform extra one-time initialization when /data is empty
# (copying defaults, creating directories, installing nodes into /data, etc.).
# Measuring both cold and warm helps separate:
#   - first-run initialization cost (cold)
#   - steady startup cost after initialization (warm)
#
# What is measured?
# -----------------
# For each container, at each sample time, we record:
#   CPU%        : Docker's CPU usage percentage (derived from cgroup CPU time).
#   Memory      : "used / limit" as reported by Docker (cgroup memory accounting).
#   Net I/O     : cumulative bytes received/transmitted by the container.
#   Block I/O   : cumulative bytes read/written by the container (storage I/O).
#   PIDs        : number of processes in the container.
#
# Important measurement notes
# ---------------------------
# 1) CPU% is a *rate-like* value computed by Docker over a short interval.
#    It fluctuates, especially during startup. For comparisons:
#       - average CPU% over a defined window is meaningful
#       - max CPU% is useful to spot spikes, but is inherently noisy
#
# 2) Net I/O and Block I/O are *counters* (they only increase). For comparisons,
#    you must compute deltas over a window:
#       delta = last_value - first_value
#    This script does that in the summary.
#
# 3) Memory is a *level* (bytes in use at sampling time). Averages and maxima
#    over a window are meaningful.
#
# Output
# ------
# Two CSV files are produced:
#   metrics_cold_<timestamp>.csv
#   metrics_warm_<timestamp>.csv
#
# Each CSV row contains the raw sampled values (already normalized to bytes where
# applicable), plus timestamps and phase labels.
#
# The script also prints a summary table for each run (cold/warm), reporting:
#   - CPU average and maximum (per phase)
#   - Memory average and maximum (per phase)
#   - Network totals (RX/TX deltas) (per phase)
#   - Block I/O totals (read/write deltas) (per phase)
#   - Average PIDs (per phase)
#
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration: images, constraints, names, ports, volumes
# -----------------------------------------------------------------------------
IMG_A="nodered-urdf-virgin-4:4.1.3-22"
IMG_B="nodered/node-red:4.1.3-22"

# For comparability, enforce identical limits (important for fair CPU%/memory%)
CPU_LIMIT="1.0"
MEM_LIMIT="1g"

# We map internal container port 1880 to different host ports to run both at once.
NAME_A="imgA"
NAME_B="imgB"
HOST_PORT_A="1880"
HOST_PORT_B="1881"

# Separate volumes so each container has its own persistent /data state.
# Cold run recreates these volumes; warm run reuses them.
VOL_A="nodered_data_A"
VOL_B="nodered_data_B"

# Sampling plan:
# - "startup": high frequency to capture early transients
# - "idle"   : lower frequency to capture steady behavior with less overhead
STARTUP_SECONDS=60     # 60 samples (1 per second)
IDLE_SECONDS=300       # 60 samples (1 per 5 seconds)

# -----------------------------------------------------------------------------
# Safety cleanup: ensure no name conflicts, even if script errors or is stopped.
# -----------------------------------------------------------------------------
cleanup() {
  # Remove containers if present (this also stops them).
  docker rm -f "$NAME_A" "$NAME_B" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# Unit conversion helpers
# -----------------------------------------------------------------------------
# Docker stats prints sizes like:
#   12.3MiB, 500kB, 1.2GB, 0B
# We convert them to integer bytes so comparisons and deltas are reliable.
to_bytes() {
  awk '
  function u2b(v,u){
    # Binary units
    if(u=="B")   return v;
    if(u=="KiB") return v*1024;
    if(u=="MiB") return v*1024*1024;
    if(u=="GiB") return v*1024*1024*1024;
    if(u=="TiB") return v*1024*1024*1024*1024;

    # Decimal units (Docker sometimes prints these)
    if(u=="kB") return v*1000;
    if(u=="MB") return v*1000*1000;
    if(u=="GB") return v*1000*1000*1000;
    if(u=="TB") return v*1000*1000*1000*1000;

    return v;
  }
  {
    match($0, /^([0-9.]+)([A-Za-z]+)$/, m);
    if(m[1]=="" || m[2]==""){ print 0; next }
    v=m[1]+0; u=m[2];
    printf "%.0f\n", u2b(v,u);
  }'
}

# Docker prints counters like "RX / TX" (two values). Convert both to bytes.
# Input example: "12.3kB / 4.5MB"
# Output: "12300,4500000"
pair_to_bytes_csv() {
  local s="$1"
  local left right left_b right_b
  left=$(echo "$s" | awk -F' / ' '{print $1}')
  right=$(echo "$s" | awk -F' / ' '{print $2}')
  left_b=$(echo "$left" | to_bytes)
  right_b=$(echo "$right" | to_bytes)
  echo "${left_b},${right_b}"
}

# -----------------------------------------------------------------------------
# Sampling function
# -----------------------------------------------------------------------------
# We poll `docker stats --no-stream` for both containers.
#
# Why `--no-stream` and polling?
# - It gives one snapshot per call (easy to timestamp and log).
# - It avoids a long-running stream that can be harder to post-process.
#
# Overhead:
# - Polling itself has small overhead, but we keep it minimal and identical for
#   both containers, so comparisons remain fair.
sample_once() {
  local phase="$1"   # "startup" or "idle"
  local out="$2"
  local epoch
  epoch=$(date +%s)

  # Format fields we want:
  #   Name, CPU%, MemUsage, NetIO, BlockIO, PIDs
  # Note: NetIO/BlockIO are cumulative counters since container start.
  docker stats --no-stream \
    --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" \
    "$NAME_A" "$NAME_B" \
  | while IFS=',' read -r name cpu memusage netio blockio pids; do
      # CPU%: strip trailing %
      cpu_num=$(echo "$cpu" | sed 's/%//')

      # MemUsage: "used / limit"
      mem_used=$(echo "$memusage" | awk -F' / ' '{print $1}')
      mem_lim=$(echo "$memusage"  | awk -F' / ' '{print $2}')
      mem_used_b=$(echo "$mem_used" | to_bytes)
      mem_lim_b=$(echo "$mem_lim"  | to_bytes)

      # NetIO: "RX / TX" (cumulative counters)
      IFS=',' read -r net_rx_b net_tx_b <<< "$(pair_to_bytes_csv "$netio")"

      # BlockIO: "read / write" (cumulative counters)
      IFS=',' read -r blk_r_b blk_w_b <<< "$(pair_to_bytes_csv "$blockio")"

      # Write one row.
      #
      # CSV columns (documented):
      #   epoch              : Unix epoch seconds (timestamp of sample)
      #   phase              : startup | idle
      #   container          : container name (imgA/imgB)
      #   cpu_pct            : CPU% snapshot (float)
      #   mem_used_bytes     : bytes in use at sample time (integer)
      #   mem_limit_bytes    : container memory limit (integer)
      #   net_rx_bytes       : cumulative bytes received since start (integer)
      #   net_tx_bytes       : cumulative bytes transmitted since start (integer)
      #   blk_read_bytes     : cumulative bytes read since start (integer)
      #   blk_write_bytes    : cumulative bytes written since start (integer)
      #   pids               : number of processes (integer)
      echo "$epoch,$phase,$name,$cpu_num,$mem_used_b,$mem_lim_b,$net_rx_b,$net_tx_b,$blk_r_b,$blk_w_b,$pids" >> "$out"
    done
}

run_phase() {
  local out="$1"

  # Startup window: 1s sampling for STARTUP_SECONDS
  for _ in $(seq 1 "$STARTUP_SECONDS"); do
    sample_once "startup" "$out"
    sleep 1
  done

  # Idle window: 5s sampling for IDLE_SECONDS
  for _ in $(seq 1 $((IDLE_SECONDS/5))); do
    sample_once "idle" "$out"
    sleep 5
  done
}

# -----------------------------------------------------------------------------
# Container lifecycle helpers
# -----------------------------------------------------------------------------
start_containers() {
  # Ensure no residual containers exist with these names.
  docker rm -f "$NAME_A" "$NAME_B" >/dev/null 2>&1 || true

  # Start containers:
  # - identical CPU/mem limits
  # - separate host ports
  # - volume mounts to /data
  docker run -d --rm --name "$NAME_A" \
    --cpus="$CPU_LIMIT" --memory="$MEM_LIMIT" \
    -p "${HOST_PORT_A}:1880" \
    -v "${VOL_A}:/data" \
    "$IMG_A" >/dev/null

  docker run -d --rm --name "$NAME_B" \
    --cpus="$CPU_LIMIT" --memory="$MEM_LIMIT" \
    -p "${HOST_PORT_B}:1880" \
    -v "${VOL_B}:/data" \
    "$IMG_B" >/dev/null
}

stop_containers() {
  # Remove immediately to avoid any name conflict race.
  docker rm -f "$NAME_A" "$NAME_B" >/dev/null 2>&1 || true
}

# -----------------------------------------------------------------------------
# Summary computation
# -----------------------------------------------------------------------------
# We compute per (container, phase):
#   - CPU avg & max (from sampled cpu_pct snapshots)
#   - Memory avg & max (from mem_used_bytes levels)
#   - Network totals: (last - first) for RX and TX bytes
#   - Block totals:   (last - first) for read/write bytes
#   - PIDs avg (simple average of sampled PIDs)
#
# Why "last - first" for Net/Block I/O?
# These are counters that monotonically increase since container start.
# A delta over a defined window is the standard way to measure "how much I/O
# happened during that window".
summarize() {
  local csv="$1"
  awk -F',' '
  NR==1{next}
  {
    phase=$2; name=$3;

    cpu=$4+0;
    mem=$5+0;
    netrx=$7+0; nettx=$8+0;
    blkr=$9+0;  blkw=$10+0;
    pids=$11+0;

    key=name "|" phase;

    # CPU
    cpu_sum[key]+=cpu; cpu_n[key]++; if(cpu>cpu_max[key]) cpu_max[key]=cpu;

    # Memory (bytes)
    mem_sum[key]+=mem; mem_n[key]++; if(mem>mem_max[key]) mem_max[key]=mem;

    # PIDs
    pids_sum[key]+=pids; pids_n[key]++;

    # Counters: store first and last values per key
    if(!(key in seen_first)){
      netrx_first[key]=netrx; nettx_first[key]=nettx;
      blkr_first[key]=blkr;   blkw_first[key]=blkw;
      seen_first[key]=1;
    }
    netrx_last[key]=netrx; nettx_last[key]=nettx;
    blkr_last[key]=blkr;   blkw_last[key]=blkw;
  }
  END{
    printf "container,phase,cpu_avg_pct,cpu_max_pct,mem_avg_bytes,mem_max_bytes,net_rx_delta_bytes,net_tx_delta_bytes,blk_read_delta_bytes,blk_write_delta_bytes,pids_avg\n";
    for(k in cpu_sum){
      split(k,a,"|"); name=a[1]; phase=a[2];

      cpu_avg = cpu_sum[k]/cpu_n[k];
      mem_avg = mem_sum[k]/mem_n[k];
      pids_avg = pids_sum[k]/pids_n[k];

      netrx_delta = netrx_last[k]-netrx_first[k];
      nettx_delta = nettx_last[k]-nettx_first[k];
      blkr_delta  = blkr_last[k]-blkr_first[k];
      blkw_delta  = blkw_last[k]-blkw_first[k];

      printf "%s,%s,%.6f,%.6f,%.0f,%.0f,%.0f,%.0f,%.0f,%.0f,%.2f\n",
        name, phase, cpu_avg, cpu_max[k], mem_avg, mem_max[k],
        netrx_delta, nettx_delta, blkr_delta, blkw_delta, pids_avg;
    }
  }' "$csv" | sort
}

# -----------------------------------------------------------------------------
# Run 1: COLD (fresh volumes)
# -----------------------------------------------------------------------------
docker volume rm "$VOL_A" "$VOL_B" >/dev/null 2>&1 || true
docker volume create "$VOL_A" >/dev/null
docker volume create "$VOL_B" >/dev/null

COLD_OUT="metrics_cold_$(date +%Y%m%d_%H%M%S).csv"
echo "epoch,phase,container,cpu_pct,mem_used_bytes,mem_limit_bytes,net_rx_bytes,net_tx_bytes,blk_read_bytes,blk_write_bytes,pids" > "$COLD_OUT"

start_containers
run_phase "$COLD_OUT"
stop_containers

echo
echo "===== SUMMARY: COLD (fresh /data volumes) ====="
summarize "$COLD_OUT"
echo "RAW: $COLD_OUT"

# -----------------------------------------------------------------------------
# Run 2: WARM (reuse volumes)
# -----------------------------------------------------------------------------
WARM_OUT="metrics_warm_$(date +%Y%m%d_%H%M%S).csv"
echo "epoch,phase,container,cpu_pct,mem_used_bytes,mem_limit_bytes,net_rx_bytes,net_tx_bytes,blk_read_bytes,blk_write_bytes,pids" > "$WARM_OUT"

start_containers
run_phase "$WARM_OUT"
stop_containers

echo
echo "===== SUMMARY: WARM (reused /data volumes) ====="
summarize "$WARM_OUT"
echo "RAW: $WARM_OUT"

