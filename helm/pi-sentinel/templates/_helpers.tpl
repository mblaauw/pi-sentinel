{{- define "pi-sentinel.name" -}}
{{- printf "%s-%s" .Release.Name .Values.task.id | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "pi-sentinel.labels" -}}
app.kubernetes.io/name: pi-sentinel
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: {{ .Values.task.id | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
{{- define "pi-sentinel.selector" -}}
app.kubernetes.io/name: pi-sentinel
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: {{ .Values.task.id | quote }}
{{- end -}}
{{- define "pi-sentinel.pod" -}}
metadata:
  labels:
    {{- include "pi-sentinel.selector" . | nindent 4 }}
  annotations:
    pi-sentinel/revision: {{ .Values.task.revision | quote }}
spec:
  serviceAccountName: {{ include "pi-sentinel.name" . }}
  automountServiceAccountToken: {{ .Values.kubernetes.enabled }}
  securityContext:
    {{- toYaml .Values.podSecurityContext | nindent 4 }}
  terminationGracePeriodSeconds: {{ .Values.runtime.terminationSeconds }}
  restartPolicy: {{ ternary "Always" "Never" (eq .Values.task.mode "continuous") }}
  {{- with .Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  containers:
    - name: worker
      image: {{ if .Values.image.digest }}{{ printf "%s@%s" .Values.image.repository .Values.image.digest | quote }}{{ else }}{{ printf "%s:%s" .Values.image.repository .Values.image.tag | quote }}{{ end }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      command: [node, /app/dist/cli.js]
      args: [worker, /task, --environment, {{ .Values.task.environment | quote }}, --platform, /task/platform.yaml, --state, /state/pi-sentinel.sqlite, --port, {{ .Values.metrics.port | quote }}]
      securityContext:
        {{- toYaml .Values.securityContext | nindent 8 }}
      resources:
        {{- toYaml .Values.resources | nindent 8 }}
      {{- if or .Values.credentials.envFromSecrets .Values.externalSecret.enabled }}
      envFrom:
        {{- range .Values.credentials.envFromSecrets }}
        - secretRef: {name: {{ . | quote }}}
        {{- end }}
        {{- if .Values.externalSecret.enabled }}
        - secretRef: {name: {{ include "pi-sentinel.name" . }}-credentials}
        {{- end }}
      {{- end }}
      {{- if .Values.caBundle.configMapName }}
      env:
        - name: NODE_EXTRA_CA_CERTS
          value: /etc/pi-sentinel-ca/ca.crt
      {{- end }}
      {{- if eq .Values.task.mode "continuous" }}
      ports: [{name: metrics, containerPort: {{ .Values.metrics.port }}}]
      startupProbe:
        httpGet: {path: /healthz, port: metrics}
        periodSeconds: 2
        failureThreshold: 60
      livenessProbe:
        httpGet: {path: /healthz, port: metrics}
        periodSeconds: 20
      readinessProbe:
        httpGet: {path: /readyz, port: metrics}
        periodSeconds: 10
      {{- end }}
      volumeMounts:
        - {name: task, mountPath: /task, readOnly: true}
        - {name: state, mountPath: /state}
        - {name: scratch, mountPath: /tmp}
        {{- if .Values.caBundle.configMapName }}
        - {name: ca, mountPath: /etc/pi-sentinel-ca, readOnly: true}
        {{- end }}
  volumes:
    - name: task
      configMap:
        name: {{ required "task.configMapName is required; run pi-sentinel task package first" .Values.task.configMapName }}
        items:
          {{- toYaml .Values.task.files | nindent 10 }}
    - name: state
      persistentVolumeClaim:
        claimName: {{ default (include "pi-sentinel.name" .) .Values.persistence.existingClaim }}
    - name: scratch
      emptyDir: {sizeLimit: 256Mi}
    {{- if .Values.caBundle.configMapName }}
    - name: ca
      configMap:
        name: {{ .Values.caBundle.configMapName | quote }}
        items: [{key: {{ .Values.caBundle.key | quote }}, path: ca.crt}]
    {{- end }}
  {{- with .Values.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end -}}
