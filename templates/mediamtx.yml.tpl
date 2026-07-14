logLevel: info
api: yes
apiAddress: 127.0.0.1:9997
authMethod: http
authHTTPAddress: http://127.0.0.1:3000/api/mtx/auth
authHTTPExclude:
- action: api
- action: metrics
- action: pprof
hls: no
rtmp: no
srt: no
rtsp: no
webrtc: yes
webrtcAddress: :8889
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: ["${PUBLIC_IP}"]
paths:
"~^live/([a-zA-Z0-9_-]{4,64})$":
source: publisher
