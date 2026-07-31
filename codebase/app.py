import streamlit as st
import requests
import json
import re

# Set up page configuration
st.set_page_config(
    page_title="VLearn Tutor AI",
    page_icon="🎓",
    layout="centered"
)

API_URL = "http://127.0.0.1:3000/api/ask"

st.title("🎓 VLearn Tutor AI")
st.markdown("Hệ thống Agentic RAG hỗ trợ học tập an toàn & chính xác.")

# Initialize chat history
if "messages" not in st.session_state:
    st.session_state.messages = []

# Display chat messages from history on app rerun
for message in st.session_state.messages:
    with st.chat_message(message["role"]):
        st.markdown(message["content"], unsafe_allow_html=True)
        if message.get("citations"):
            st.markdown(f"**Citations:** `{', '.join(message['citations'])}`")

# React to user input
if prompt := st.chat_input("Hỏi bất cứ điều gì về khóa học..."):
    # Display user message in chat message container
    st.chat_message("user").markdown(prompt)
    # Add user message to chat history
    st.session_state.messages.append({"role": "user", "content": prompt})

    with st.chat_message("assistant"):
        with st.spinner("Đang tra cứu dữ liệu..."):
            try:
                response = requests.post(API_URL, json={"question": prompt, "top": []}, timeout=60)
                if response.status_code == 200:
                    data = response.json()
                    answer = data.get("answer", "Lỗi: Không có phản hồi từ máy chủ.")
                    citations = data.get("citations", [])
                    
                    # Highlight citations in the answer [Txx-NNN]
                    cite_pattern = r'(\[(?:T\d{2}-\d{1,3}|C\d{4}-T\d{4}-[QA]|C\d{4}|S\d+)\])'
                    highlighted_answer = re.sub(cite_pattern, r'<span style="color:#3b82f6; font-weight:bold;">\1</span>', answer)

                    st.markdown(highlighted_answer, unsafe_allow_html=True)
                    if citations:
                        st.markdown(f"**Citations:** `{', '.join(citations)}`")
                    
                    # Add assistant response to chat history
                    st.session_state.messages.append({
                        "role": "assistant", 
                        "content": highlighted_answer,
                        "citations": citations
                    })
                else:
                    st.error(f"Lỗi kết nối API: {response.status_code}")
            except Exception as e:
                st.error(f"Lỗi: {str(e)}")
