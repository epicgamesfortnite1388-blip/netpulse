//! NANI Time-Series Analysis Module
//!
//! Provides exponential smoothing, autoregressive models, rolling regressions,
//! trend detection, and seasonal pattern analysis for network measurements.
//!
//! All methods are online (incremental) and bounded in memory.

use crate::network_intelligence::math::clamp_probability;
use std::collections::VecDeque;

/// Exponential smoothing (single exponential / simple moving average equivalent).
///
/// S_t = alpha * x_t + (1 - alpha) * S_{t-1}
///
/// Suitable for data without trend or seasonality.
#[derive(Debug, Clone, Default)]
pub struct ExponentialSmoothing {
    alpha: f64,
    state: Option<f64>,
    n: u64,
}

impl ExponentialSmoothing {
    /// Create with smoothing factor alpha (0 < alpha <= 1).
    /// Higher alpha = more weight on recent observations.
    pub fn new(alpha: f64) -> Option<Self> {
        if alpha <= 0.0 || alpha > 1.0 || !alpha.is_finite() {
            return None;
        }
        Some(Self {
            alpha,
            state: None,
            n: 0,
        })
    }

    /// Default alpha = 0.3.
    pub fn default_smoothing() -> Self {
        Self::new(0.3).unwrap()
    }

    /// Add an observation and return the smoothed value.
    pub fn observe(&mut self, x: f64) -> f64 {
        if !x.is_finite() {
            return self.state.unwrap_or(0.0);
        }
        let new_state = match self.state {
            None => x,
            Some(s) => self.alpha * x + (1.0 - self.alpha) * s,
        };
        self.state = Some(new_state);
        self.n += 1;
        new_state
    }

    /// Current smoothed value.
    pub fn value(&self) -> Option<f64> {
        self.state
    }

    /// Number of observations.
    pub fn n(&self) -> u64 {
        self.n
    }
}

/// Double exponential smoothing (Holt's method) for data with trend.
///
/// Level: L_t = alpha * x_t + (1 - alpha) * (L_{t-1} + T_{t-1})
/// Trend: T_t = beta * (L_t - L_{t-1}) + (1 - beta) * T_{t-1}
/// Forecast: F_{t+1} = L_t + T_t
#[derive(Debug, Clone, Default)]
pub struct DoubleExponentialSmoothing {
    alpha: f64,
    beta: f64,
    level: Option<f64>,
    trend: Option<f64>,
    n: u64,
}

impl DoubleExponentialSmoothing {
    /// Create with smoothing factors alpha (level) and beta (trend).
    pub fn new(alpha: f64, beta: f64) -> Option<Self> {
        if alpha <= 0.0 || alpha > 1.0 || beta <= 0.0 || beta > 1.0 {
            return None;
        }
        if !alpha.is_finite() || !beta.is_finite() {
            return None;
        }
        Some(Self {
            alpha,
            beta,
            level: None,
            trend: None,
            n: 0,
        })
    }

    /// Default: alpha = 0.3, beta = 0.1.
    pub fn default_double() -> Self {
        Self::new(0.3, 0.1).unwrap()
    }

    /// Add an observation and return the forecast for the next period.
    pub fn observe(&mut self, x: f64) -> f64 {
        if !x.is_finite() {
            return self.forecast();
        }

        let prev_level = self.level.unwrap_or(x);
        let prev_trend = self.trend.unwrap_or(0.0);

        let new_level = self.alpha * x + (1.0 - self.alpha) * (prev_level + prev_trend);
        let new_trend = self.beta * (new_level - prev_level) + (1.0 - self.beta) * prev_trend;

        self.level = Some(new_level);
        self.trend = Some(new_trend);
        self.n += 1;

        new_level + new_trend
    }

    /// Forecast for the next period (h steps ahead).
    pub fn forecast(&self) -> f64 {
        match (self.level, self.trend) {
            (Some(l), Some(t)) => l + t,
            (Some(l), None) => l,
            _ => 0.0,
        }
    }

    /// Forecast h steps ahead.
    pub fn forecast_h(&self, h: u64) -> f64 {
        match (self.level, self.trend) {
            (Some(l), Some(t)) => l + t * h as f64,
            (Some(l), None) => l,
            _ => 0.0,
        }
    }

    /// Number of observations.
    pub fn n(&self) -> u64 {
        self.n
    }
}

/// Rolling window statistics for trend detection.
///
/// Maintains a bounded window of recent values and computes
/// trend direction and magnitude.
#[derive(Debug, Clone, Default)]
pub struct RollingTrend {
    window: VecDeque<f64>,
    max_size: usize,
}

impl RollingTrend {
    /// Create with window size.
    pub fn new(max_size: usize) -> Self {
        Self {
            window: VecDeque::with_capacity(max_size),
            max_size: max_size.max(3),
        }
    }

    /// Add an observation.
    pub fn observe(&mut self, x: f64) {
        if !x.is_finite() {
            return;
        }
        if self.window.len() >= self.max_size {
            self.window.pop_front();
        }
        self.window.push_back(x);
    }

    /// Compute the trend slope using linear regression on the window.
    /// Returns None if fewer than 2 observations.
    pub fn slope(&self) -> Option<f64> {
        let n = self.window.len();
        if n < 2 {
            return None;
        }

        let values: Vec<f64> = self.window.iter().copied().collect();
        let x_mean = (n - 1) as f64 / 2.0;
        let y_mean = values.iter().sum::<f64>() / n as f64;

        let mut numerator = 0.0;
        let mut denominator = 0.0;
        for (i, &y) in values.iter().enumerate() {
            let dx = i as f64 - x_mean;
            let dy = y - y_mean;
            numerator += dx * dy;
            denominator += dx * dx;
        }

        if denominator == 0.0 {
            return Some(0.0);
        }

        Some(numerator / denominator)
    }

    /// Determine trend direction.
    pub fn trend_direction(&self) -> TrendDirection {
        match self.slope() {
            Some(s) if s > 0.01 => TrendDirection::Increasing,
            Some(s) if s < -0.01 => TrendDirection::Decreasing,
            _ => TrendDirection::Stable,
        }
    }

    /// Number of observations.
    pub fn len(&self) -> usize {
        self.window.len()
    }
}

/// Trend direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrendDirection {
    Increasing,
    Decreasing,
    Stable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_smoothing_converges() {
        let mut es = ExponentialSmoothing::new(0.5).unwrap();

        // Constant value should converge to that value
        for _ in 0..100 {
            es.observe(5.0);
        }
        assert!((es.value().unwrap() - 5.0).abs() < 0.01);
    }

    #[test]
    fn exponential_smoothing_weights_recent() {
        let mut es = ExponentialSmoothing::new(0.5).unwrap();
        es.observe(0.0);
        let v1 = es.value().unwrap();
        es.observe(10.0);
        let v2 = es.value().unwrap();
        assert!(v2 > v1);
    }

    #[test]
    fn double_exponential_smoothing_trend() {
        let mut des = DoubleExponentialSmoothing::new(0.3, 0.1).unwrap();

        // Increasing trend
        for i in 0..50 {
            des.observe(i as f64);
        }
        let forecast = des.forecast();
        assert!(forecast > 49.0); // Should predict above last value due to trend
    }

    #[test]
    fn rolling_trend_direction() {
        let mut rt = RollingTrend::new(10);

        // Increasing trend
        for i in 0..10 {
            rt.observe(i as f64);
        }
        assert_eq!(rt.trend_direction(), TrendDirection::Increasing);

        // Decreasing trend
        let mut rt2 = RollingTrend::new(10);
        for i in (0..10).rev() {
            rt2.observe(i as f64);
        }
        assert_eq!(rt2.trend_direction(), TrendDirection::Decreasing);
    }

    #[test]
    fn exponential_smoothing_rejects_invalid_alpha() {
        assert!(ExponentialSmoothing::new(0.0).is_none());
        assert!(ExponentialSmoothing::new(1.5).is_none());
        assert!(ExponentialSmoothing::new(f64::NAN).is_none());
    }

    #[test]
    fn double_exponential_smoothing_rejects_invalid() {
        assert!(DoubleExponentialSmoothing::new(0.0, 0.1).is_none());
        assert!(DoubleExponentialSmoothing::new(0.5, 0.0).is_none());
        assert!(DoubleExponentialSmoothing::new(0.5, 1.5).is_none());
    }
}
