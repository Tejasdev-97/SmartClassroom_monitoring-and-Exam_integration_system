/**
 * ExamProctor.ai — Classroom Monitoring API Service.
 * Wraps all /classroom/* REST calls using the existing configured Axios instance.
 */

import api from '../../../services/api';

const BASE = '/classroom';

// ── Policies ──────────────────────────────────────────────────────────────────
export const classroomApi = {
  // Policies
  listPolicies: () => api.get(`${BASE}/policies`),
  createPolicy: (data) => api.post(`${BASE}/policies`, data),
  getPolicy: (id) => api.get(`${BASE}/policies/${id}`),
  updatePolicy: (id, data) => api.put(`${BASE}/policies/${id}`, data),
  deletePolicy: (id) => api.delete(`${BASE}/policies/${id}`),

  // Devices
  listDevices: (params) => api.get(`${BASE}/devices`, { params }),
  getDevice: (id) => api.get(`${BASE}/devices/${id}`),
  approveDevice: (id, data) => api.post(`${BASE}/devices/${id}/approve`, data),
  revokeDevice: (id) => api.post(`${BASE}/devices/${id}/revoke`),

  // Sessions
  listSessions: (params) => api.get(`${BASE}/sessions`, { params }),
  createSession: (data) => api.post(`${BASE}/sessions`, data),
  getSession: (id) => api.get(`${BASE}/sessions/${id}`),
  startSession: (id) => api.post(`${BASE}/sessions/${id}/start`),
  pauseSession: (id) => api.post(`${BASE}/sessions/${id}/pause`),
  endSession: (id) => api.post(`${BASE}/sessions/${id}/end`),
  getSessionPolicy: (id) => api.get(`${BASE}/sessions/${id}/policy`),

  // Session devices
  assignDevices: (sessionId, devices) => api.post(`${BASE}/sessions/${sessionId}/devices`, devices),
  unassignDevice: (sessionId, deviceId) => api.delete(`${BASE}/sessions/${sessionId}/devices/${deviceId}`),
  getGrid: (sessionId) => api.get(`${BASE}/sessions/${sessionId}/grid`),

  // Alerts
  listAlerts: (sessionId, params) => api.get(`${BASE}/sessions/${sessionId}/alerts`, { params }),
  reviewAlert: (sessionId, alertId, data) => api.put(`${BASE}/sessions/${sessionId}/alerts/${alertId}`, data),
  getAlertSummary: (sessionId) => api.get(`${BASE}/sessions/${sessionId}/alerts/summary`),

  // Commands
  issueCommand: (sessionId, data) => api.post(`${BASE}/sessions/${sessionId}/commands`, data),
  listCommands: (sessionId, params) => api.get(`${BASE}/sessions/${sessionId}/commands`, { params }),

  // Screen thumbnail (for display)
  getThumbnailUrl: (deviceId, frameId) =>
    `${api.defaults.baseURL?.replace('/api/v1', '') || ''}/storage/classroom_thumbnails/${deviceId}/${frameId}.jpg`,
};

export default classroomApi;
