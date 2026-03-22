import React from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { store } from './store';
import LandingPage from './components/common/LandingPage';
import AnnotationPage from './components/2d/AnnotationPage';
import ManualAnnotation from './components/2d/ManualAnnotation';
import PoseAnnotationPage from './components/9d/PoseAnnotationPage';
import PoseManualAnnotation from './components/9d/PoseManualAnnotation';
import './App.css';

const AppContent: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/annotate" element={<AnnotationPage />} />
        <Route path="/annotate/manual-annotation" element={<ManualAnnotation />} />
        <Route path="/pose/manual-annotation" element={<PoseManualAnnotation />} />
        <Route path="/pose" element={<PoseAnnotationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
};

function App() {
  return (
    <Provider store={store}>
      <AppContent />
    </Provider>
  );
}

export default App;