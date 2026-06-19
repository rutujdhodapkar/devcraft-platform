import os
import json
import logging
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from io import BytesIO
from xhtml2pdf import pisa
import urllib.request

app = Flask(__name__)
CORS(app)

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Constants and paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INQUIRIES_FILE = os.path.join(BASE_DIR, 'inquiries.json')
REFERRALS_FILE = os.path.join(BASE_DIR, 'referrals.json')
VISITS_FILE = os.path.join(BASE_DIR, 'referral-visits.json')
ADMINS_FILE = os.path.join(BASE_DIR, 'admins.json')

# Cache for currency exchange rates
cached_rates = None
last_fetch_time = 0

# Fallback exchange rates
fallback_rates = {
    "USD": 1.0,
    "INR": 83.5,
    "EUR": 0.93,
    "GBP": 0.79,
    "CAD": 1.37,
    "AUD": 1.51,
    "JPY": 157.4
}

# Helpers to read/write JSON files
def read_json(file_path, fallback=[]):
    if not os.path.exists(file_path):
        return fallback
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error reading {file_path}: {e}")
        return fallback

def write_json(file_path, data):
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Error writing to {file_path}: {e}")

# Live currency exchange rate proxy
@app.route('/api/rates', methods=['GET'])
def get_rates():
    global cached_rates
    try:
        # Fetch fresh rates
        req = urllib.request.Request("https://open.er-api.com/v6/latest/USD", headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            if data and "rates" in data:
                cached_rates = data["rates"]
                return jsonify({"success": True, "rates": cached_rates, "source": "network"})
    except Exception as e:
        logger.warning(f"Failed to fetch exchange rates, using fallback: {e}")
    
    return jsonify({"success": True, "rates": cached_rates or fallback_rates, "source": "fallback"})

# PDF Generation Endpoint
@app.route('/api/generate-pdf', methods=['POST'])
def generate_pdf():
    try:
        data = request.get_json()
        if not data or 'html_content' not in data:
            return jsonify({"success": False, "message": "html_content is required"}), 400
        
        html_content = data['html_content']
        pdf_buffer = BytesIO()
        
        # Compile HTML to PDF
        pisa_status = pisa.CreatePDF(html_content, dest=pdf_buffer)
        
        if pisa_status.err:
            return jsonify({"success": False, "message": "Failed to render PDF"}), 500
        
        pdf_buffer.seek(0)
        filename = data.get('filename', 'document.pdf')
        
        return send_file(
            pdf_buffer,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        logger.exception("Error in PDF generation")
        return jsonify({"success": False, "message": str(e)}), 500

# Legacy inquiry endpoint (for backup support if client needs it)
@app.route('/api/inquire', methods=['POST'])
def save_inquiry():
    data = request.get_json() or {}
    name = data.get('name')
    email = data.get('email')
    phone = data.get('phone')
    project_type = data.get('projectType', 'custom')
    plan_tier = data.get('planTier', 'custom')

    if not name or not email or not phone:
        return jsonify({"success": False, "message": "Name, Email, and Phone are required."}), 400

    new_inquiry = {
        "id": f"INQ-{int(urllib.request.time.time() * 1000)}",
        "createdAt": urllib.request.time.strftime('%Y-%m-%dT%H:%M:%SZ', urllib.request.time.gmtime()),
        **data,
        "name": name,
        "email": email,
        "phone": phone,
        "projectType": project_type,
        "planTier": plan_tier,
        "status": data.get('status', 'contacted'),
        "progress": data.get('progress', 'New request')
    }

    inquiries = read_json(INQUIRIES_FILE)
    inquiries.append(new_inquiry)
    write_json(INQUIRIES_FILE, inquiries)

    return jsonify({
        "success": True, 
        "message": "Inquiry received successfully!",
        "inquiryId": new_inquiry["id"]
    }), 201

# Admin details
@app.route('/api/admin-data', methods=['GET'])
def get_admin_data():
    requests = read_json(INQUIRIES_FILE)
    referrals = read_json(REFERRALS_FILE)
    visits = read_json(VISITS_FILE)

    sorted_requests = sorted(requests, key=lambda x: x.get('createdAt', ''), reverse=True)
    sorted_visits = sorted(visits, key=lambda x: x.get('visitedAt', ''), reverse=True)[:100]

    return jsonify({
        "success": True,
        "data": {
            "requests": sorted_requests,
            "referrals": referrals,
            "visits": sorted_visits
        }
    })

# Referrals CRUD
@app.route('/api/referrals', methods=['POST'])
def create_referral():
    data = request.get_json() or {}
    referrals = read_json(REFERRALS_FILE)

    code = str(data.get('code') or f"REF-{urllib.request.time.strftime('%M%S%f')[:8]}").upper()
    while any(str(item.get('code', '')).upper() == code for item in referrals):
        code = f"REF-{urllib.request.time.strftime('%M%S%f')[:8]}".upper()

    referral = {
        "id": code,
        "code": code,
        "name": str(data.get('name', '')).strip(),
        "email": str(data.get('email', '')).strip(),
        "city": str(data.get('city', '')).strip(),
        "phone": str(data.get('phone', '')).strip(),
        "upiId": str(data.get('upiId', '')).strip(),
        "visited": int(data.get('visited', 0)),
        "assignedInternships": int(data.get('assignedInternships', 0)),
        "loggedIn": int(data.get('loggedIn', 0)),
        "createdAt": data.get('createdAt') or urllib.request.time.strftime('%Y-%m-%dT%H:%M:%SZ', urllib.request.time.gmtime()),
        "updatedAt": data.get('updatedAt') or urllib.request.time.strftime('%Y-%m-%dT%H:%M:%SZ', urllib.request.time.gmtime()),
    }

    referrals.append(referral)
    write_json(REFERRALS_FILE, referrals)
    return jsonify({"success": True, "data": referral}), 201

@app.route('/api/referral-visits', methods=['POST'])
def track_referral_visit():
    data = request.get_json() or {}
    referrals = read_json(REFERRALS_FILE)
    visits = read_json(VISITS_FILE)

    code = str(data.get('referralCode', '')).upper()
    matched_referral = next((item for item in referrals if str(item.get('code', '')).upper() == code), None)
    
    visit = {
        "id": f"VIS-{int(urllib.request.time.time() * 1000)}",
        **data,
        "referralCode": code,
        "matched": matched_referral is not None,
        "visitedAt": data.get('visitedAt') or urllib.request.time.strftime('%Y-%m-%dT%H:%M:%SZ', urllib.request.time.gmtime()),
        "action": "visited"
    }

    visits.append(visit)
    if matched_referral:
        matched_referral["visited"] = int(matched_referral.get("visited", 0)) + 1
        matched_referral["lastVisitedAt"] = visit["visitedAt"]

    write_json(REFERRALS_FILE, referrals)
    write_json(VISITS_FILE, visits)
    return jsonify({"success": True, "data": visit}), 201

@app.route('/api/referrals/<code>', methods=['DELETE'])
def delete_referral(code):
    code_upper = str(code).upper()
    referrals = read_json(REFERRALS_FILE)
    filtered = [item for item in referrals if str(item.get('code', '')).upper() != code_upper]
    write_json(REFERRALS_FILE, filtered)
    return jsonify({"success": True, "message": f"Referral {code_upper} deleted."})

@app.route('/api/inquiries/<id>', methods=['DELETE'])
def delete_inquiry(id):
    inquiries = read_json(INQUIRIES_FILE)
    filtered = [item for item in inquiries if item.get('id') != id]
    write_json(INQUIRIES_FILE, filtered)
    return jsonify({"success": True, "message": f"Inquiry {id} deleted."})

@app.route('/api/referrals/<code>/contacted', methods=['POST'])
def mark_referral_contacted(code):
    referrals = read_json(REFERRALS_FILE)
    code_upper = str(code).upper()
    matched_referral = next((item for item in referrals if str(item.get('code', '')).upper() == code_upper), None)

    if matched_referral:
        matched_referral["contacted"] = int(matched_referral.get("contacted", 0)) + 1
        matched_referral["lastContactedAt"] = urllib.request.time.strftime('%Y-%m-%dT%H:%M:%SZ', urllib.request.time.gmtime())
        write_json(REFERRALS_FILE, referrals)

    return jsonify({"success": True, "data": matched_referral})

# Admin Verification API
@app.route('/api/check-admin', methods=['POST'])
def check_admin():
    data = request.get_json() or {}
    email = data.get('email')
    if not email:
        return jsonify({"success": False, "message": "Email required."}), 400
    
    clean_email = email.lower().strip()
    if clean_email == 'rutujdhodapkar@gmail.com':
        return jsonify({"success": True, "isAdmin": True})
    
    admins = read_json(ADMINS_FILE)
    is_admin = any(admin_email.lower().strip() == clean_email for admin_email in admins)
    return jsonify({"success": True, "isAdmin": is_admin})

@app.route('/api/admins', methods=['GET'])
def get_admins():
    admins = read_json(ADMINS_FILE)
    return jsonify({"success": True, "data": admins})

@app.route('/api/admins', methods=['POST'])
def add_admin():
    data = request.get_json() or {}
    email = data.get('email')
    if not email:
        return jsonify({"success": False, "message": "Email required."}), 400
    
    clean_email = email.lower().strip()
    admins = read_json(ADMINS_FILE)
    if clean_email not in admins:
        admins.append(clean_email)
        write_json(ADMINS_FILE, admins)
    
    return jsonify({"success": True, "data": admins})

@app.route('/api/admins/<email>', methods=['DELETE'])
def delete_admin(email):
    clean_email = email.lower().strip()
    admins = read_json(ADMINS_FILE)
    updated = [admin_email for admin_email in admins if admin_email.lower().strip() != clean_email]
    write_json(ADMINS_FILE, updated)
    return jsonify({"success": True, "data": updated})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"Starting Python server on port {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
