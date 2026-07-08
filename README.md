# 🛡️ DetoxWeb

DetoxWeb is an AI-powered browser extension that dynamically scans web pages in real-time and visually blurs toxic comments. It uses a custom-trained TensorFlow/Keras binary classification model served via a lightweight FastAPI backend.

Built for both **Google Chrome** and **Mozilla Firefox** (Manifest V3), DetoxWeb puts you in control of your browsing experience by hiding harassment, insults, and toxic language before you read it, while allowing you to optionally reveal blurred content.

---

## ✨ Features

- **Real-Time DOM Scanning:** Watches the page for new text nodes and processes them as you scroll (perfect for infinite-scroll sites like Reddit or Twitter).
- **Zero-Latency Caching:** Implements sentence-level deduplication and an LRU cache (both client-side and server-side) to drastically reduce server load and eliminate redundant ML inference.
- **Global Toggle:** A simple "always-on" global switch. Turn it off when you don't need it, and on when you do.
- **Premium UI:** Smooth blur animations and a clean, stats-driven popup UI showing real-time scanned vs. toxic metrics.
- **Privacy-First:** All processing is done locally on your machine via the FastAPI server. No text is sent to third-party cloud APIs.

---

## 🧠 Model Architecture & Hyperparameter Tuning

The core machine learning engine of **DetoxWeb** is built using TensorFlow/Keras. The objective was to build a highly optimized, lightweight, and fast baseline model capable of running real-time inference on web text.

### 🏗️ Base Architecture
* **Vectorization Layer:** `TextVectorization` configured to `tf_idf` output mode.
* **Hidden Layer:** Dense layer (32 units, ReLU activation) paired with an aggressive `Dropout(0.6)` layer to combat overfitting.
* **Output Layer:** Dense layer (1 unit, Sigmoid activation) outputting a toxicity probability score between 0.0 and 1.0.

---

### ❌ The "Graveyard" (Failed Strategies)

Before reaching the final configuration, several common "best practices" were attempted and abandoned because they actively harmed the model's performance on this specific dataset:

* **Aggressive Class Weights:** Because the Jigsaw dataset is highly imbalanced (~90% clean, 10% toxic), heavily forcing high class weights caused the model to become wildly paranoid. It began flagging borderline clean or constructive comments as toxic, tanking test accuracy to **70%** due to severe false-positive inflation.
* **Massive Vocabulary Limits (`max_tokens=10,000`):** Expanding the vocabulary to 10k tokens caused the model to overfit severely. The network began memorizing rare, specific words found only in the training set rather than learning generalized language patterns, leading to an explosive test loss of **1.9266**.
* **Simultaneous Hyperparameter Shifting:** Attempting to apply multiple fixes at once (e.g., shrinking the vocabulary size while simultaneously expanding ngrams) caused conflicting gradient signals. For instance, limiting tokens to 1,500 while trying to learn bigrams choked out the newly generated word pairs before the model could process them.

---

### 📉 The Optimization Journey (What Worked)

Getting the model to generalize well required moving past raw metric illusions and systematically isolating variables—changing exactly **one thing at a time**.

#### 1. Feature Engineering: The N-Gram Upgrade
Instead of looking at words in absolute isolation (Unigrams), the `TextVectorization` layer was upgraded to **Bigrams** (`ngrams=2`). This single change allowed the network to learn contextual sequence phrases (e.g., mapping "not" and "good" together as "not good"), expanding its semantic understanding.

#### 2. Vocabulary Squeezing
The vocabulary ceiling was optimized away from the bloated 10k threshold down to a tight, high-impact window. This forced the model to stop relying on rare edge-case tokens and instead focus on universal indicators of toxicity.

#### 3. Gradient Smoothing (Batch Size Optimization)
Training originally utilized a standard `batch_size=64`. By scaling the batch size up to **128**, the model processed a more representative sample of data per gradient step. This smoothed out the optimization path, acted as a natural regularizer, and drastically deflated validation loss.

---

### 📊 Final Performance Metrics

Through iterative tuning, the model successfully broke through the 90% accuracy ceiling while completely stabilizing validation loss, demonstrating excellent generalization on unseen data.

| Metric | Baseline Model | Optimized Model (Final) |
| :--- | :---: | :---: |
| **Train Accuracy** | 94.93% | **94.23%** |
| **Train Loss** | 0.1997 | **0.2135** |
| **Test Accuracy** | 83.00% | **90.77%** 🚀 |
| **Test Loss** | 1.9266 | **0.5264** 📉 |

### 🔑 Key Takeaway
The final model achieved a **~7.7% absolute increase in test accuracy** while simultaneously slashing the test loss by **72.6%**. This confirms that the model is making highly confident, accurate classifications and has reached the functional performance ceiling for a flat bag-of-words NLP architecture.

---

## 🛠️ Tech Stack

- **Extension:** Manifest V3, Vanilla JavaScript, HTML/CSS.
- **Backend:** FastAPI, Uvicorn, Python.
- **Machine Learning:** TensorFlow, Keras.

---

## 🚀 How to Use

To use DetoxWeb, you need to add the extension to your browser and run the local AI backend.

### 1. Add the Extension to Your Browser

**For Google Chrome:**
1. Open Chrome and navigate to `chrome://extensions/`
2. Toggle **"Developer mode"** ON in the top right corner.
3. Click the **"Load unpacked"** button.
4. Select the `Extension/` folder from this project.

**For Mozilla Firefox:**
1. Open Firefox and navigate to `about:debugging`
2. Click **"This Firefox"** in the left sidebar.
3. Click **"Load Temporary Add-on"**.
4. Select the `manifest.json` file located inside the `Extension/` folder.

### 2. Run the Local AI Server

Since DetoxWeb processes text locally for maximum privacy, it needs the inference server running in the background.

```bash
# Clone the repository
git clone <your-repo-url>
cd DetoxWeb

# Install Python dependencies
pip install -r requirements.txt

# Start the FastAPI server
cd Extension
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

### 3. Start Browsing
1. Open any webpage (e.g., Reddit, Twitter).
2. Click the DetoxWeb shield icon in your browser toolbar to open the popup.
3. Ensure the global filter is toggled **ON**.
4. The extension will automatically detect and blur toxic content on the fly. Click the "👁 Reveal" button on any blurred text if you wish to read it.
