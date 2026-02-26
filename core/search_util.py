import json
from ddgs import DDGS

def search_and_summarize(query, max_results=3):
    """
    Performs a DuckDuckGo search and returns a formatted string of the top results.
    """
    print(f"--- [SearchUtil] Searching DuckDuckGo for: '{query}' ---")
    results = []
    
    with DDGS() as ddgs:
        # 1. Fetch text results
        try:
            for r in ddgs.text(query, max_results=max_results):
                r['source_type'] = 'Web'
                results.append(r)
        except Exception as e:
            print(f"--- [SearchUtil] DDG Text Search Exception: {e} ---")
            
        # 2. Fetch news results for time-sensitive queries
        try:
            for r in ddgs.news(query, max_results=max_results):
                r['source_type'] = 'News'
                r['body'] = r.get('body', '') + f" (Date: {r.get('date', 'Unknown')})"
                results.append(r)
        except Exception as e:
            print(f"--- [SearchUtil] DDG News Search Exception: {e} ---")

    if not results:
        return "No results found for that query."

    # Format the results for the LLM
    formatted_output = ""
    for idx, r in enumerate(results, 1):
        title = r.get('title', 'No Title')
        href = r.get('href', r.get('url', 'No URL'))
        body = r.get('body', 'No Description')
        stype = r.get('source_type', 'Web')
        
        formatted_output += f"Result {idx} ({stype}):\n"
        formatted_output += f"Title: {title}\n"
        formatted_output += f"Source: {href}\n"
        formatted_output += f"Summary: {body}\n\n"
        
    return formatted_output.strip()
