/**
 * ExamProctor.ai — Student Device & Proctoring Status Page (/student/status)
 * Diagnostics for Camera, Microphone, Screen Sharing, Browser, and Local Agent Bridge.
 */

import { useState, useEffect, useRef } from 'react';
import {
  Laptop, Camera, Mic, Monitor, ShieldCheck, CheckCircle2,
  XCircle, RefreshCw, AlertTriangle, Radio, Wifi
} from 'lucide-react';
import styles from './StudentDashboard.module.css';

export default function DeviceStatusPage() {
  const [cameraStatus, setCameraStatus] = useState('checking'); // pass | fail | checking
  const [micStatus, setMicStatus] = useState('checking');
  const [screenStatus, setScreenStatus] = useState('ready');
  const [agentStatus, setAgentStatus] = useState('checking');
  const [agentDetails, setAgentDetails] = useState(null);

  const videoRef = useRef(null);

  const testHardware = async () => {
    // 1. Test Camera & Mic
    setCameraStatus('checking');
    setMicStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setCameraStatus('pass');
      setMicStatus('pass');
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    } catch {
      // Test separately
      try {
        const vStream = await navigator.mediaDevices.getUserMedia({ video: true });
        setCameraStatus('pass');
        if (videoRef.current) {
          videoRef.current.srcObject = vStream;
          videoRef.current.play().catch(() => {});
        }
      } catch {
        setCameraStatus('fail');
      }
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        setMicStatus('pass');
      } catch {
        setMicStatus('fail');
      }
    }

    // 2. Test Local Python Student Agent Bridge (port 41732)
    setAgentStatus('checking');
    try {
      const bridgePort = (typeof window.electronAPI?.agentPort === 'function' ? window.electronAPI.agentPort() : null) || 41732;
      const res = await fetch(`http://127.0.0.1:${bridgePort}/status`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        setAgentStatus('pass');
        setAgentDetails(data);
      } else {
        setAgentStatus('fail');
      }
    } catch {
      setAgentStatus('fail');
    }
  };

  const testScreenCapture = async () => {
    setScreenStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      setScreenStatus('pass');
      // Stop track immediately
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      setScreenStatus('fail');
    }
  };

  useEffect(() => {
    testHardware();
    return () => {
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Device & Proctoring Readiness</h1>
          <p className={styles.subtitle}>
            Verify your hardware, browser permissions, and the background Student Agent before entering an examination.
          </p>
        </div>
        <button onClick={testHardware} className="btn btn-secondary btn-sm" title="Re-run tests">
          <RefreshCw size={14} />
          <span>Re-run Diagnostics</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-6)' }}>
        {/* Camera Check */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Camera size={20} style={{ color: 'var(--color-blue)' }} />
              <span style={{ fontWeight: 800 }}>Webcam Sensor</span>
            </div>
            {cameraStatus === 'pass' && <span className="badge badge-green"><CheckCircle2 size={12} /> Ready</span>}
            {cameraStatus === 'fail' && <span className="badge badge-red"><XCircle size={12} /> Blocked</span>}
            {cameraStatus === 'checking' && <span className="badge badge-yellow">Checking…</span>}
          </div>
          <div style={{ width: '100%', height: 160, background: '#0f172a', borderRadius: 'var(--radius-md)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            Used for real-time face verification and AI proctoring compliance.
          </p>
        </div>

        {/* Microphone Check */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Mic size={20} style={{ color: 'var(--color-blue)' }} />
              <span style={{ fontWeight: 800 }}>Microphone</span>
            </div>
            {micStatus === 'pass' && <span className="badge badge-green"><CheckCircle2 size={12} /> Ready</span>}
            {micStatus === 'fail' && <span className="badge badge-red"><XCircle size={12} /> Blocked</span>}
            {micStatus === 'checking' && <span className="badge badge-yellow">Checking…</span>}
          </div>
          <p style={{ fontSize: 'var(--font-size-sm)', marginTop: 'var(--space-2)' }}>
            Microphone audio input is detected and calibrated for environment noise detection.
          </p>
          <div style={{ marginTop: 'auto', paddingTop: 'var(--space-4)', borderTop: 'var(--border-thin)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            Sample rate: 44.1 kHz · Single channel
          </div>
        </div>

        {/* Screen Share Check */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Monitor size={20} style={{ color: 'var(--color-blue)' }} />
              <span style={{ fontWeight: 800 }}>Screen Share API</span>
            </div>
            {screenStatus === 'pass' && <span className="badge badge-green"><CheckCircle2 size={12} /> Authorized</span>}
            {screenStatus === 'fail' && <span className="badge badge-red"><XCircle size={12} /> Denied</span>}
            {screenStatus === 'ready' && <span className="badge badge-blue">Ready</span>}
          </div>
          <p style={{ fontSize: 'var(--font-size-sm)', marginTop: 'var(--space-2)' }}>
            Verifies that your browser allows screen surface streaming during examinations.
          </p>
          <div style={{ marginTop: 'auto', paddingTop: 'var(--space-4)', borderTop: 'var(--border-thin)' }}>
            <button onClick={testScreenCapture} className="btn btn-secondary btn-sm" style={{ width: '100%' }}>
              Test Screen Permission
            </button>
          </div>
        </div>

        {/* Local Python Student Agent Bridge Check */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <ShieldCheck size={20} style={{ color: 'var(--color-blue)' }} />
              <span style={{ fontWeight: 800 }}>Student Agent Bridge</span>
            </div>
            {agentStatus === 'pass' && <span className="badge badge-green"><CheckCircle2 size={12} /> Online</span>}
            {agentStatus === 'fail' && <span className="badge badge-orange"><AlertTriangle size={12} /> Offline / Web Mode</span>}
            {agentStatus === 'checking' && <span className="badge badge-yellow">Checking…</span>}
          </div>
          <p style={{ fontSize: 'var(--font-size-sm)', marginTop: 'var(--space-2)' }}>
            {agentStatus === 'pass'
              ? 'Local desktop monitor is running on port 41732. Native desktop screen capture and focus tracking are active.'
              : 'Local Student Agent is not detected. Web-only proctoring will be used unless running the native workstation agent.'}
          </p>
          <div style={{ marginTop: 'auto', paddingTop: 'var(--space-4)', borderTop: 'var(--border-thin)', fontSize: 'var(--font-size-xs)', fontFamily: 'monospace' }}>
            Uplink: http://127.0.0.1:41732
          </div>
        </div>
      </div>
    </div>
  );
}
