@echo off
set NETPULSE_PORT=47615
set NETPULSE_DATA_DIR=C:\Users\RADIN\AppData\Local\Temp\netpulse-vpnproof\data
set NETPULSE_MIGRATIONS_DIR=E:\Code\Project\Vpn_app\src-tauri\backend\drizzle
set NETPULSE_DESKTOP=1
set NETPULSE_CORES_DIR=C:\Users\RADIN\AppData\Local\Temp\netpulse-vpnproof\cores

echo da9f3c7b2a1e0f9d4c8b7a6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c > C:\Users\RADIN\AppData\Local\Temp\netpulse-vpnproof\evidence\daemon-token.txt

E:\Code\Project\Vpn_app\src-tauri\backend\node.exe E:\Code\Project\Vpn_app\src-tauri\backend\netpulse-backend.js < C:\Users\RADIN\AppData\Local\Temp\netpulse-vpnproof\evidence\daemon-token.txt
